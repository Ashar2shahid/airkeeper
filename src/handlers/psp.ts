import * as abi from '@api3/airnode-abi';
import * as node from '@api3/airnode-node';
import { ethers } from 'ethers';
import { Dictionary } from 'lodash';
import flatMap from 'lodash/flatMap';
import groupBy from 'lodash/groupBy';
import isEmpty from 'lodash/isEmpty';
import isNil from 'lodash/isNil';
import map from 'lodash/map';
import { checkSubscriptionCondition } from '../evm/check-conditions';
import { callApi } from '../api/call-api';
import { loadAirnodeConfig, mergeConfigs, parseConfig } from '../config';
import { initializeProvider } from '../evm/initialize-provider';
import { processTransactions } from '../evm/process-transactions';
import { getSponsorWalletAndTransactionCount } from '../evm/tansaction-count';
import {
  ChainConfig,
  Config,
  EVMProviderState,
  FullSubscription,
  ProviderState,
  SponsorWalletTransactionCount,
  SponsorWalletWithSubscriptions,
  State,
  GroupedSubscriptions,
} from '../types';
import { retryGo } from '../utils';

export const handler = async (_event: any = {}): Promise<any> => {
  const startedAt = new Date();

  const airnodeConfig = loadAirnodeConfig();
  // This file will be merged with config.json from above
  const airkeeperConfig: Config = parseConfig('airkeeper');
  const config = mergeConfigs(airnodeConfig, airkeeperConfig);

  const state = await updateBeacon(config);

  const completedAt = new Date();
  const durationMs = Math.abs(completedAt.getTime() - startedAt.getTime());
  node.logger.info(
    `PSP beacon update finished at ${node.utils.formatDateTime(completedAt)}. Total time: ${durationMs}ms`,
    state.baseLogOptions
  );

  const response = {
    ok: true,
    data: { message: 'PSP beacon update execution has finished' },
  };
  return { statusCode: 200, body: JSON.stringify(response) };
};

const initializeState = (config: Config): State => {
  const { triggers, subscriptions } = config;

  const baseLogOptions = node.logger.buildBaseOptions(config, {
    coordinatorId: node.utils.randomHexString(8),
  });

  const airnodeWallet = ethers.Wallet.fromMnemonic(config.nodeSettings.airnodeWalletMnemonic);

  const enabledSubscriptions: FullSubscription[] = [];
  triggers['proto-psp'].forEach((subscriptionId) => {
    // Get subscriptions details
    const subscription = subscriptions[subscriptionId];
    if (isNil(subscription)) {
      node.logger.warn(`SubscriptionId ${subscriptionId} not found in subscriptions`, baseLogOptions);
      return;
    }
    // Verify subscriptionId
    const expectedSubscriptionId = ethers.utils.solidityKeccak256(
      ['uint256', 'address', 'bytes32', 'bytes', 'bytes', 'address', 'address', 'address', 'bytes4'],
      [
        subscription.chainId,
        subscription.airnodeAddress,
        subscription.templateId,
        subscription.parameters,
        subscription.conditions,
        subscription.relayer,
        subscription.sponsor,
        subscription.requester,
        subscription.fulfillFunctionId,
      ]
    );
    if (subscriptionId !== expectedSubscriptionId) {
      node.logger.warn(
        `SubscriptionId ${subscriptionId} does not match expected ${expectedSubscriptionId}`,
        baseLogOptions
      );
      return;
    }

    // TODO: should we also check that airnodeWallet.address === subscription.airnodeAddress? 🤔

    enabledSubscriptions.push({
      ...subscription,
      id: subscriptionId,
    });
  });

  const groupedSubscriptions: GroupedSubscriptions[] = [];
  if (isEmpty(enabledSubscriptions)) {
    node.logger.info('No proto-psp subscriptions to process', baseLogOptions);
  } else {
    const enabledSubscriptionsByTemplateId = groupBy(enabledSubscriptions, 'templateId');
    Object.keys(enabledSubscriptionsByTemplateId).forEach((templateId) => {
      // Get template details
      const template = config.templates[templateId];
      if (isNil(template)) {
        node.logger.warn(`TemplateId ${templateId} not found in templates`, baseLogOptions);
        return;
      }
      // Verify templateId
      const expectedTemplateId = ethers.utils.solidityKeccak256(
        ['bytes32', 'bytes'],
        [template.endpointId, template.templateParameters]
      );
      if (expectedTemplateId !== templateId) {
        node.logger.warn(`TemplateId ${templateId} does not match expected ${expectedTemplateId}`, baseLogOptions);
        return;
      }

      // Get endpoint details
      const endpoint = config.endpoints[template.endpointId];
      if (isNil(endpoint)) {
        node.logger.warn(`EndpointId ${template.endpointId} not found in endpoints`, baseLogOptions);
        return;
      }
      // Verify endpointId
      const expectedEndpointId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['string', 'string'], [endpoint.oisTitle, endpoint.endpointName])
      );
      if (expectedEndpointId !== template.endpointId) {
        node.logger.warn(
          `EndpointId ${template.endpointId} does not match expected ${expectedEndpointId}`,
          baseLogOptions
        );
        return;
      }

      groupedSubscriptions.push({
        subscriptions: enabledSubscriptionsByTemplateId[templateId],
        template: { ...template, id: templateId },
        endpoint: { ...endpoint, id: template.endpointId },
      });
    });
  }

  return {
    config,
    baseLogOptions,
    airnodeWallet,
    groupedSubscriptions,
    apiValuesBySubscriptionId: {},
    providerStates: [],
  };
};

const executeApiCalls = async (state: State): Promise<State> => {
  const { config, baseLogOptions, groupedSubscriptions } = state;

  let apiValuesBySubscriptionId: { [subscriptionId: string]: ethers.BigNumber } = {};
  for (const { subscriptions, template, endpoint } of groupedSubscriptions) {
    const templateIdLogOptions = {
      ...baseLogOptions,
      additional: {
        templateId: template.id,
      },
    };
    const apiCallParameters = abi.decode(template.templateParameters);
    const [errorCallApi, logsData] = await retryGo(() =>
      callApi({
        oises: config.ois,
        apiCredentials: config.apiCredentials,
        apiCallParameters,
        oisTitle: endpoint.oisTitle,
        endpointName: endpoint.endpointName,
      })
    );
    if (!isNil(errorCallApi) || isNil(logsData)) {
      node.logger.warn('Failed to fecth API value', templateIdLogOptions);
      continue;
    }
    const [logs, apiValue] = logsData;
    node.logger.logPending(logs, templateIdLogOptions);

    if (isNil(apiValue)) {
      node.logger.warn('Failed to fetch API value. Skipping update...', templateIdLogOptions);
      continue;
    }

    apiValuesBySubscriptionId = {
      ...apiValuesBySubscriptionId,
      ...subscriptions.reduce((acc, subscription) => ({ ...acc, [subscription.id]: apiValue }), {}),
    };
  }

  return { ...state, apiValuesBySubscriptionId };
};

const initializeProviders = async (state: State): Promise<State> => {
  const { config, baseLogOptions, airnodeWallet } = state;

  const evmChains = config.chains.filter((chain: ChainConfig) => chain.type === 'evm');
  if (isEmpty(evmChains)) {
    throw new Error('One or more evm compatible chain(s) must be defined in the provided config');
  }
  const providerPromises = flatMap(
    evmChains.map((chain: ChainConfig) =>
      map(chain.providers, async (chainProvider, providerName) => {
        const providerLogOptions: node.LogOptions = {
          ...baseLogOptions,
          meta: {
            ...baseLogOptions.meta,
            chainId: chain.id,
            providerName,
          },
        };

        // Initialize provider specific data
        const [logs, providerState] = await initializeProvider(chain, chainProvider.url || '');
        node.logger.logPending(logs, providerLogOptions);

        return { config, baseLogOptions, airnodeWallet, ...providerState, chainId: chain.id, providerName };
      })
    )
  );

  const providerStates = await Promise.all(providerPromises);
  const validProviderStates = providerStates.filter((ps) => !isNil(ps)) as ProviderState<EVMProviderState>[];

  return { ...state, providerStates: validProviderStates };
};

async function checkSubscriptionsConditions(
  subscriptions: FullSubscription[],
  apiValuesBySubscriptionId: { [subscriptionId: string]: ethers.BigNumber },
  contract: ethers.Contract,
  voidSigner: ethers.VoidSigner,
  logOptions: node.LogOptions
) {
  const validSubscriptions: FullSubscription[] = [];
  const conditionPromises = subscriptions.map(
    (subscription) =>
      checkSubscriptionCondition(subscription, apiValuesBySubscriptionId[subscription.id], contract, voidSigner).then(
        ([logs, isValid]) => [logs, { subscription, isValid }]
      ) as Promise<node.LogsData<{ subscription: FullSubscription; isValid: boolean }>>
  );
  const result = await Promise.all(conditionPromises);
  result.forEach(([log, data]) => {
    const subscriptionLogOptions = {
      ...logOptions,
      additional: {
        ...logOptions.additional,
        subscriptionId: data.subscription.id,
      },
    };
    node.logger.logPending(log, subscriptionLogOptions);
    if (data.isValid) {
      validSubscriptions.push({
        ...data.subscription,
        apiValue: apiValuesBySubscriptionId[data.subscription.id],
      });
    }
  });

  return validSubscriptions;
}

async function groupSubscriptionsBySponsorWallet(
  subscriptionsBySponsor: Dictionary<FullSubscription[]>,
  config: Config,
  provider: ethers.providers.Provider,
  currentBlock: number,
  providerLogOptions: node.LogOptions
): Promise<SponsorWalletWithSubscriptions[]> {
  const sponsorWalletsWithSubscriptions: SponsorWalletWithSubscriptions[] = [];
  const sponsorAddresses = Object.keys(subscriptionsBySponsor);
  const sponsorWalletPromises = sponsorAddresses.map(
    (sponsor) =>
      getSponsorWalletAndTransactionCount(config, provider, currentBlock, sponsor).then(([logs, data]) => [
        logs,
        { ...data, sponsor },
      ]) as Promise<node.LogsData<SponsorWalletTransactionCount & { sponsor: string }>>
  );
  const transactionCounts = await Promise.all(sponsorWalletPromises);
  transactionCounts.forEach(([logs, data]) => {
    const sponsorWalletLogOptions = {
      ...providerLogOptions,
      additional: {
        sponsor: data.sponsor,
      },
    };
    node.logger.logPending(logs, sponsorWalletLogOptions);

    if (!isNil(data.sponsorWallet) && !isNil(data.transactionCount)) {
      let nextNonce = data.transactionCount;
      sponsorWalletsWithSubscriptions.push({
        subscriptions: subscriptionsBySponsor[data.sponsor].map((subscription) => ({
          ...subscription,
          nonce: nextNonce++,
        })),
        sponsorWallet: data.sponsorWallet,
      });
    }
  });

  return sponsorWalletsWithSubscriptions;
}

const submitTransactions = async (state: State) => {
  const { config, baseLogOptions, providerStates, groupedSubscriptions, apiValuesBySubscriptionId } = state;

  const providerPromises = providerStates.map(async (providerState) => {
    const { providerName, chainId, provider, contracts, voidSigner, currentBlock } = providerState;
    const providerLogOptions = {
      ...baseLogOptions,
      meta: {
        ...baseLogOptions.meta,
        providerName,
        chainId,
      },
    };

    // Filter subscription by chainId and check that subscription has an associated API value
    const subscriptions = flatMap(groupedSubscriptions.map((s) => s.subscriptions));
    const chainSubscriptions = subscriptions.filter(
      (subscription) => subscription.chainId === chainId && apiValuesBySubscriptionId[subscription.id]
    );

    // Check conditions
    const validSubscriptions = await checkSubscriptionsConditions(
      chainSubscriptions,
      apiValuesBySubscriptionId,
      contracts['DapiServer'],
      voidSigner,
      providerLogOptions
    );

    // Group subscriptions by sponsor address
    const subscriptionsBySponsor = groupBy(validSubscriptions, 'sponsor');

    // Fetch sponsor wallet transaction counts to assign nonces to subscriptions
    // and group subscriptions by sponsor wallet
    const subscriptionsBySponsorWallets = await groupSubscriptionsBySponsorWallet(
      subscriptionsBySponsor,
      config,
      provider,
      currentBlock,
      providerLogOptions
    );

    // Execute transactions
    const logs = await processTransactions({ ...providerState, subscriptionsBySponsorWallets });
    node.logger.logPending(logs as any, providerLogOptions);
  });

  await Promise.all(providerPromises);
};

const updateBeacon = async (config: Config) => {
  // =================================================================
  // STEP 1: Initialize state
  // =================================================================
  let state: State = initializeState(config);
  node.logger.debug('Initial state created...', state.baseLogOptions);

  // **************************************************************************
  // STEP 2: Make API calls
  // **************************************************************************
  state = await executeApiCalls(state);
  node.logger.debug('API requests executed...', state.baseLogOptions);

  // **************************************************************************
  // STEP 3. Initialize providers
  // **************************************************************************
  state = await initializeProviders(state);
  node.logger.debug('Providers initialized...', state.baseLogOptions);

  // **************************************************************************
  // STEP 4. Initiate transactions for each provider, sponsor wallet pair
  // **************************************************************************
  await submitTransactions(state);
  node.logger.debug('Transactions submitted...', state.baseLogOptions);

  return state;
};
