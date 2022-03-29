import * as abi from '@api3/airnode-abi';
import * as utils from '@api3/airnode-utilities';
import { goSync } from '@api3/promise-utils';
import { AttemptOptions, retry } from '@lifeomic/attempt';
import { ethers } from 'ethers';
import groupBy from 'lodash/groupBy';
import isEmpty from 'lodash/isEmpty';
import isNil from 'lodash/isNil';
import { callApi } from '../api/call-api';
import { loadAirkeeperConfig, loadAirnodeConfig, mergeConfigs } from '../config';
import { getSponsorWalletAndTransactionCount, initializeProvider, processSponsorWallet } from '../evm';
import { buildLogOptions } from '../logger';
import {
  CallApiResult,
  CheckedSubscription,
  Config,
  EVMProviderState,
  GroupedSubscriptions,
  Id,
  ProviderSponsorSubscriptions,
  ProviderState,
  State,
} from '../types';
import { Subscription } from '../validator';
import { shortenAddress } from '../wallet';

export const handler = async (_event: any = {}): Promise<any> => {
  const startedAt = new Date();

  const airnodeConfig = goSync(loadAirnodeConfig);
  if (!airnodeConfig.success) {
    utils.logger.error(airnodeConfig.error.message);
    throw airnodeConfig.error;
  }
  // This file will be merged with config.json from above
  const airkeeperConfig = goSync(loadAirkeeperConfig);
  if (!airkeeperConfig.success) {
    utils.logger.error(airkeeperConfig.error.message);
    throw airkeeperConfig.error;
  }
  const config = mergeConfigs(airnodeConfig.data, airkeeperConfig.data);

  const state = await updateBeacon(config);

  const completedAt = new Date();
  const durationMs = Math.abs(completedAt.getTime() - startedAt.getTime());
  utils.logger.info(
    `PSP beacon update finished at ${utils.formatDateTime(completedAt)}. Total time: ${durationMs}ms`,
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

  const baseLogOptions = utils.buildBaseOptions(config, {
    coordinatorId: utils.randomHexString(8),
  });

  const enabledSubscriptions = triggers.protoPsp.reduce((acc: Id<Subscription>[], subscriptionId) => {
    // Get subscriptions details
    const subscription = subscriptions[subscriptionId];
    if (isNil(subscription)) {
      utils.logger.warn(`SubscriptionId ${subscriptionId} not found in subscriptions`, baseLogOptions);
      return acc;
    }
    // Verify subscriptionId
    const expectedSubscriptionId = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
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
      )
    );
    if (subscriptionId !== expectedSubscriptionId) {
      utils.logger.warn(
        `SubscriptionId ${subscriptionId} does not match expected ${expectedSubscriptionId}`,
        baseLogOptions
      );
      return acc;
    }

    return [
      ...acc,
      {
        ...subscription,
        id: subscriptionId,
      },
    ];
  }, []);

  if (isEmpty(enabledSubscriptions)) {
    utils.logger.info('No proto-PSP subscriptions to process', baseLogOptions);
  }

  const enabledSubscriptionsByTemplateId = groupBy(enabledSubscriptions, 'templateId');
  const groupedSubscriptions = Object.keys(enabledSubscriptionsByTemplateId).reduce(
    (acc: GroupedSubscriptions[], templateId) => {
      // Get template details
      const template = config.templates[templateId];
      if (isNil(template)) {
        utils.logger.warn(`TemplateId ${templateId} not found in templates`, baseLogOptions);
        return acc;
      }
      // Verify templateId
      const expectedTemplateId = ethers.utils.solidityKeccak256(
        ['bytes32', 'bytes'],
        [template.endpointId, template.templateParameters]
      );
      if (expectedTemplateId !== templateId) {
        utils.logger.warn(`TemplateId ${templateId} does not match expected ${expectedTemplateId}`, baseLogOptions);
        return acc;
      }

      // Get endpoint details
      const endpoint = config.endpoints[template.endpointId];
      if (isNil(endpoint)) {
        utils.logger.warn(`EndpointId ${template.endpointId} not found in endpoints`, baseLogOptions);
        return acc;
      }
      // Verify endpointId
      const expectedEndpointId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['string', 'string'], [endpoint.oisTitle, endpoint.endpointName])
      );
      if (expectedEndpointId !== template.endpointId) {
        utils.logger.warn(
          `EndpointId ${template.endpointId} does not match expected ${expectedEndpointId}`,
          baseLogOptions
        );
        return acc;
      }

      return [
        ...acc,
        {
          subscriptions: enabledSubscriptionsByTemplateId[templateId],
          template: { ...template, id: templateId },
          endpoint: { ...endpoint, id: template.endpointId },
        },
      ];
    },
    []
  );

  return {
    config,
    baseLogOptions,
    groupedSubscriptions,
    apiValuesBySubscriptionId: {},
    providerStates: [],
  };
};

const executeApiCalls = async (state: State): Promise<State> => {
  const { config, baseLogOptions, groupedSubscriptions } = state;

  const baseAttemptOptions: AttemptOptions<any> = {
    delay: 0,
    maxAttempts: 0,
    initialDelay: 0,
    minDelay: 0,
    maxDelay: 0,
    factor: 0,
    timeout: 0,
    jitter: false,
    handleError: null,
    handleTimeout: null,
    beforeAttempt: null,
    calculateDelay: null,
  };

  let hasApiCallWrapperTimedout = false;
  const responses: CallApiResult[] = [];
  const apiValuePromises = groupedSubscriptions.map(async ({ subscriptions, template, endpoint }) => {
    const apiCallParameters = abi.decode(template.templateParameters);
    const startMs = Date.now();
    let hasApiCallTimedout = false;
    try {
      const result = await retry<CallApiResult>(
        async () => {
          try {
            // console.log('🚀 ~ file: psp.ts ~ line 203 ~ apiValuePromises ~ hasApiCallTimeout', hasApiCallTimeout);
            // if (!hasApiCallWrapperTimedout && !hasApiCallTimedout) {
            const [logs, data] = await callApi(config, endpoint, apiCallParameters);
            return [logs, { templateId: template.id, apiValue: data, subscriptions }];
            // } else {
            //   // console.log('🚀 ~ file: psp.ts ~ line 217 ~ apiValuePromises ~ else');
            //   return [
            //     [utils.logger.pend('ERROR', '🚀 ~ timedout')],
            //     { templateId: template.id, apiValue: null, subscriptions },
            //   ] as CallApiResult;
            // }
          } catch (err) {
            //console.log('🚀 ~ INNER ERROR->>>>>>>>>>>>>>>>', err);
            if (hasApiCallTimedout || hasApiCallWrapperTimedout) {
              return [
                [utils.logger.pend('ERROR', '🚀 ~ timedout')],
                { templateId: template.id, apiValue: null, subscriptions },
              ] as CallApiResult;
            }
            throw err;
          }
        },
        {
          ...baseAttemptOptions,
          delay: 200,
          minDelay: 100,
          maxDelay: 500,
          factor: 2,
          timeout: 1000,
          jitter: true,
        }
      );

      //console.log('🚀 ~ file: psp.ts ~ line 237 ~ apiValuePromises ~ result', result);
      responses.push(result);
      // return result;
    } catch (err) {
      //console.log('🚀 ~ OUTER ERROR->>>>>>>>>>>>>>>>', err);
      hasApiCallTimedout = (err as any).code === 'ATTEMPT_TIMEOUT';
      // throw err;
    } finally {
      console.log('ELAPSED CHILD: ', Date.now() - startMs);
    }
  });

  const beforeMs = Date.now();
  try {
    await retry(
      async () => {
        await new Promise((res) => setTimeout(res, 4010));
        await Promise.all(apiValuePromises);
      },
      { ...baseLogOptions, timeout: 4000 }
    );
  } catch (err) {
    hasApiCallWrapperTimedout = (err as any).code === 'ATTEMPT_TIMEOUT';
    // console.log('🚀 ~ file: psp.ts ~ line 255 ~ apiValuePromises ~ catch', err);
  } finally {
    console.log('ELAPSED PARENT: ', Date.now() - beforeMs);
  }

  console.log('🚀 ~ file: psp.ts ~ line 222 ~ executeApiCalls ~ responses', responses);

  const apiValuesBySubscriptionId = responses.reduce((acc: { [subscriptionId: string]: ethers.BigNumber }, result) => {
    // if (!result.success) {
    //   utils.logger.warn('Failed to fetch API value', baseLogOptions);
    //   return acc;
    // }

    const [logs, data] = result;

    const templateLogOptions = buildLogOptions('additional', { templateId: data.templateId }, baseLogOptions);

    utils.logger.logPending(logs, templateLogOptions);

    if (isNil(data.apiValue)) {
      utils.logger.warn('Failed to fetch API value. Skipping update...', templateLogOptions);
      return acc;
    }

    return {
      ...acc,
      ...data.subscriptions.reduce((acc2, { id }) => {
        return { ...acc2, [id]: data.apiValue };
      }, {}),
    };
  }, {});

  console.log('🚀 ~ file: psp.ts ~ line 242 ~ executeApiCalls ~ apiValuesBySubscriptionId', apiValuesBySubscriptionId);
  return { ...state, apiValuesBySubscriptionId };
};

const initializeProviders = async (state: State): Promise<State> => {
  const { config, baseLogOptions } = state;

  const airnodeWallet = ethers.Wallet.fromMnemonic(config.nodeSettings.airnodeWalletMnemonic);

  const evmChains = config.chains.filter((chain) => chain.type === 'evm');
  if (isEmpty(evmChains)) {
    throw new Error('One or more evm compatible chains must be defined in the provided config');
  }
  const providerPromises = evmChains.flatMap((chain) =>
    Object.entries(chain.providers).map(async ([providerName, chainProvider]) => {
      const providerLogOptions = buildLogOptions('meta', { chainId: chain.id, providerName }, baseLogOptions);

      // Initialize provider specific data
      const [logs, evmProviderState] = await initializeProvider(chain, chainProvider.url || '');
      utils.logger.logPending(logs, providerLogOptions);
      if (isNil(evmProviderState)) {
        utils.logger.warn('Failed to initialize provider', providerLogOptions);
        return null;
      }

      return {
        airnodeWallet,
        chainId: chain.id,
        providerName,
        ...evmProviderState,
      };
    })
  );

  const providerStates = await Promise.all(providerPromises);
  const validProviderStates = providerStates.filter((ps) => !isNil(ps)) as ProviderState<EVMProviderState>[];

  return { ...state, providerStates: validProviderStates };
};

const processSubscriptions = async (
  providerSponsorSubscriptions: ProviderSponsorSubscriptions[],
  baseLogOptions: utils.LogOptions
) => {
  const providerSponsorPromises = providerSponsorSubscriptions.map(async (subscriptionGroup) => {
    const { sponsorAddress, providerState, subscriptions } = subscriptionGroup;
    const { airnodeWallet, providerName, chainId, provider, contracts, voidSigner, currentBlock, gasTarget } =
      providerState;

    const providerLogOptions = buildLogOptions('meta', { chainId, providerName }, baseLogOptions);

    // Fetch sponsor wallet transaction counts to be able to assign nonces to subscriptions
    const [transactionCountLogs, walletData] = await getSponsorWalletAndTransactionCount(
      airnodeWallet,
      provider,
      currentBlock,
      sponsorAddress
    );

    // Skip processing for the current sponsorAddress if the wallet functions fail
    if (isNil(walletData)) {
      const sponsorLogOptions = buildLogOptions('additional', { sponsor: sponsorAddress }, providerLogOptions);
      utils.logger.warn('Failed to fetch sponsor wallet or transaction count', sponsorLogOptions);
      return;
    }

    const { sponsorWallet, transactionCount } = walletData;

    const sponsorWalletLogOptions = buildLogOptions(
      'additional',
      { sponsorWallet: shortenAddress(sponsorWallet.address) },
      providerLogOptions
    );
    utils.logger.logPending(transactionCountLogs, sponsorWalletLogOptions);

    utils.logger.info(`Processing ${subscriptions.length} subscription(s)`, sponsorWalletLogOptions);

    const logs = await processSponsorWallet(
      airnodeWallet,
      contracts['DapiServer'],
      gasTarget,
      subscriptions,
      sponsorWallet,
      voidSigner,
      transactionCount
    );

    logs.forEach(([logs, data]) => {
      const subscriptionLogOptions = buildLogOptions(
        'additional',
        { subscriptionId: data.id },
        sponsorWalletLogOptions
      );
      utils.logger.logPending(logs, subscriptionLogOptions);
    });
  });

  await Promise.all(providerSponsorPromises);
};

const submitTransactions = async (state: State) => {
  const { baseLogOptions, groupedSubscriptions, apiValuesBySubscriptionId, providerStates } = state;

  const subscriptions = groupedSubscriptions.flatMap((s) => s.subscriptions);

  const providerSponsorSubscriptions = providerStates.reduce(
    (
      acc: {
        sponsorAddress: string;
        providerState: ProviderState<EVMProviderState>;
        subscriptions: Id<CheckedSubscription>[];
      }[],
      providerState
    ) => {
      // Filter subscription by chainId, double-check that subscription has an associated API value and add
      // it to the subscription object
      const chainSubscriptions = subscriptions.reduce(
        (acc: (Id<Subscription> & { apiValue: ethers.BigNumber })[], subscription) => {
          if (subscription.chainId === providerState.chainId && apiValuesBySubscriptionId[subscription.id])
            return [...acc, { ...subscription, apiValue: apiValuesBySubscriptionId[subscription.id] }];
          return acc;
        },
        []
      );

      // Group filtered subscriptions by sponsorAddress
      const subscriptionsBySponsor = groupBy(chainSubscriptions, 'sponsor');

      // Collect subscriptions for each provider + sponsor pair
      const subscriptionGroup = Object.entries(subscriptionsBySponsor).map(([sponsorAddress, subscriptions]) => ({
        sponsorAddress: sponsorAddress,
        providerState: providerState,
        subscriptions,
      }));

      return [...acc, ...subscriptionGroup];
    },
    []
  );

  // TODO: start new lambdas for each providerSubscriptions array element
  await processSubscriptions(providerSponsorSubscriptions, baseLogOptions);
};

const updateBeacon = async (config: Config) => {
  // =================================================================
  // STEP 1: Initialize state
  // =================================================================
  let state: State = initializeState(config);
  utils.logger.debug('Initial state created...', state.baseLogOptions);

  // **************************************************************************
  // STEP 2: Make API calls
  // **************************************************************************
  state = await executeApiCalls(state);
  utils.logger.debug('API requests executed...', state.baseLogOptions);
  return state;
  // **************************************************************************
  // STEP 3. Initialize providers
  // **************************************************************************
  state = await initializeProviders(state);
  utils.logger.debug('Providers initialized...', state.baseLogOptions);

  // **************************************************************************
  // STEP 4. Initiate transactions for each provider, sponsor wallet pair
  // **************************************************************************
  await submitTransactions(state);
  utils.logger.debug('Transactions submitted...', state.baseLogOptions);

  return state;
};
