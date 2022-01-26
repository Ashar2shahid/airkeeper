import * as path from "path";
import * as ethers from "ethers";
import * as ois from "@api3/airnode-ois";
import * as node from "@api3/airnode-node";
import * as adapter from "@api3/airnode-adapter";
import * as protocol from "@api3/airnode-protocol";
import * as abi from "@api3/airnode-abi";
import flatMap from "lodash/flatMap";
import groupBy from "lodash/groupBy";
import isEmpty from "lodash/isEmpty";
import isNil from "lodash/isNil";
import map from "lodash/map";
import merge from "lodash/merge";
import { ChainConfig } from "./types";
import {
  loadAirkeeperConfig,
  deriveKeeperSponsorWallet,
  retryGo,
} from "./utils";
// TODO: use node.evm.getGasPrice() once @api3/airnode-node is updated to v0.4.x
import { getGasPrice } from "./gas-prices";

export const GAS_LIMIT = 500_000;
export const BLOCK_COUNT_HISTORY_LIMIT = 300;

export const handler = async (_event: any = {}): Promise<any> => {
  const startedAt = new Date();

  // **************************************************************************
  // 1. Load config (this file must be the same as the one used by the node)
  // **************************************************************************
  const nodeConfigPath = path.resolve(`${__dirname}/../config/config.json`);
  const nodeConfig = node.config.parseConfig(nodeConfigPath, process.env);
  const keeperConfig = loadAirkeeperConfig();
  const config = merge(nodeConfig, keeperConfig);

  const baseLogOptions = node.logger.buildBaseOptions(config, {
    coordinatorId: node.utils.randomString(8),
  });
  node.logger.info(
    `Airkeeper started at ${node.utils.formatDateTime(startedAt)}`,
    baseLogOptions
  );

  const { chains, nodeSettings, triggers, ois: oises, apiCredentials } = config;
  const evmChains = chains.filter(
    (chain: node.ChainConfig & ChainConfig) => chain.type === "evm"
  );
  if (isEmpty(chains)) {
    throw new Error(
      "One or more evm compatible chain(s) must be defined in the provided config"
    );
  }

  const providerPromises = flatMap(
    evmChains.map((chain: node.ChainConfig & ChainConfig) => {
      return map(chain.providers, async (chainProvider, providerName) => {
        const providerLogOptions = {
          ...baseLogOptions,
          meta: {
            ...baseLogOptions.meta,
            providerName,
            chainId: chain.id,
          },
        };

        // **************************************************************************
        // 2. Initialize provider specific data
        // **************************************************************************
        node.logger.debug("initializing...", providerLogOptions);
        const blockHistoryLimit =
          chain.blockHistoryLimit || BLOCK_COUNT_HISTORY_LIMIT;
        const chainProviderUrl = chainProvider.url || "";
        const provider = node.evm.buildEVMProvider(chainProviderUrl, chain.id);

        const airnodeRrp = protocol.AirnodeRrpFactory.connect(
          chain.contracts.AirnodeRrp,
          provider
        );

        const rrpBeaconServer = protocol.RrpBeaconServerFactory.connect(
          chain.contracts.RrpBeaconServer,
          provider
        );

        const airnodeHDNode = ethers.utils.HDNode.fromMnemonic(
          nodeSettings.airnodeWalletMnemonic
        );

        // Fetch current block number from chain via provider
        const [err, currentBlock] = await retryGo(() =>
          provider.getBlockNumber()
        );
        if (err || isNil(currentBlock)) {
          node.logger.error("failed to fetch the blockNumber", {
            ...providerLogOptions,
            error: err,
          });
          return;
        }

        // **************************************************************************
        // 3. Run grouped by keeperSponsor address jobs in parallel
        //    but each keeper job in the group sequentially
        // **************************************************************************
        const rrpBeaconServerKeeperJobsByKeeperSponsor = groupBy(
          triggers.rrpBeaconServerKeeperJobs,
          "keeperSponsor"
        );
        const keeperSponsorAddresses = Object.keys(
          rrpBeaconServerKeeperJobsByKeeperSponsor
        );

        const keeperSponsorWalletPromises = keeperSponsorAddresses.map(
          async (keeperSponsor) => {
            const keeperSponsorWallet = deriveKeeperSponsorWallet(
              airnodeHDNode,
              keeperSponsor,
              provider
            );

            const keeperSponsorWalletLogOptions = {
              ...providerLogOptions,
              additional: {
                keeperSponsorWallet: keeperSponsorWallet.address.replace(
                  keeperSponsorWallet.address.substring(5, 38),
                  "..."
                ),
              },
            };

            // Fetch keeperSponsorWallet transaction count
            const [err, keeperSponsorWalletTransactionCount] = await retryGo(
              () =>
                provider.getTransactionCount(
                  keeperSponsorWallet.address,
                  currentBlock
                )
            );
            if (err || isNil(keeperSponsorWalletTransactionCount)) {
              node.logger.error(
                "failed to fetch the keeperSponsorWallet transaction count",
                {
                  ...keeperSponsorWalletLogOptions,
                  error: err,
                }
              );
              return;
            }
            let nonce = keeperSponsorWalletTransactionCount;

            const rrpBeaconServerKeeperJobs =
              rrpBeaconServerKeeperJobsByKeeperSponsor[keeperSponsor];

            for (const {
              templateId,
              overrideParameters,
              templateParameters,
              oisTitle,
              endpointName,
              deviationPercentage,
              requestSponsor,
            } of rrpBeaconServerKeeperJobs) {
              const configParameters = [
                ...templateParameters,
                ...overrideParameters,
              ];
              const encodedParameters = abi.encode(configParameters);
              const beaconId = ethers.utils.solidityKeccak256(
                ["bytes32", "bytes"],
                [templateId, encodedParameters]
              );

              const beaconIdLogOptions = {
                ...keeperSponsorWalletLogOptions,
                additional: {
                  ...keeperSponsorWalletLogOptions.additional,
                  beaconId,
                },
              };

              // Verify deviationPercentage is between 0 and 100 and has only 2 decimal places
              if (
                isNaN(Number(deviationPercentage)) ||
                Number(deviationPercentage) <= 0 ||
                Number(deviationPercentage) > 100 ||
                !Number.isInteger(Number(deviationPercentage) * 100) // Only 2 decimal places is allowed
              ) {
                node.logger.error(
                  `deviationPercentage '${deviationPercentage}' must be a number larger than 0 and less then or equal to 100 with no more than 2 decimal places`,
                  beaconIdLogOptions
                );
                continue;
              }

              // Verify templateId matches data in rrpBeaconServerKeeperJob
              const airnodeAddress = airnodeHDNode.derivePath(
                ethers.utils.defaultPath
              ).address;
              const endpointId = ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                  ["string", "string"],
                  [oisTitle, endpointName]
                )
              );
              const encodedTemplateParameters = abi.encode(templateParameters);
              const expectedTemplateId =
                node.evm.templates.getExpectedTemplateId({
                  airnodeAddress,
                  endpointId,
                  encodedParameters: encodedTemplateParameters,
                  id: templateId,
                });
              if (expectedTemplateId !== templateId) {
                node.logger.error(
                  `templateId '${templateId}' does not match expected templateId '${expectedTemplateId}'`,
                  beaconIdLogOptions
                );
                continue;
              }

              // **************************************************************************
              // 4. Read beacon
              // **************************************************************************
              node.logger.debug("reading beacon value...", beaconIdLogOptions);

              // address(0) is considered whitelisted
              const voidSigner = new ethers.VoidSigner(
                ethers.constants.AddressZero,
                provider
              );
              const [errReadBeacon, beaconResponse] = await retryGo(() =>
                rrpBeaconServer.connect(voidSigner).readBeacon(beaconId)
              );
              if (
                errReadBeacon ||
                isNil(beaconResponse) ||
                isNil(beaconResponse.value)
              ) {
                node.logger.error(
                  `failed to read value for beaconId: ${beaconId}`,
                  {
                    ...beaconIdLogOptions,
                    error: errReadBeacon,
                  }
                );
                continue;
              }
              node.logger.info(
                `beacon server value: ${beaconResponse.value.toString()}`,
                beaconIdLogOptions
              );

              // **************************************************************************
              // 5. Make API request
              // **************************************************************************
              node.logger.debug("making API request...", beaconIdLogOptions);
              const configOis = oises.find((o) => o.title === oisTitle)!;
              const configEndpoint = configOis.endpoints.find(
                (e) => e.name === endpointName
              )!;
              const apiCallParameters = configParameters.reduce(
                (acc, p) => ({ ...acc, [p.name]: p.value }),
                {}
              );
              const reservedParameters =
                node.adapters.http.parameters.getReservedParameters(
                  configEndpoint,
                  apiCallParameters || {}
                );
              if (!reservedParameters._type) {
                node.logger.error(
                  `reserved parameter 'type' is missing for endpoint: ${endpointName}`,
                  beaconIdLogOptions
                );
                continue;
              }
              const sanitizedParameters: adapter.Parameters =
                node.utils.removeKeys(
                  apiCallParameters || {},
                  ois.RESERVED_PARAMETERS
                );
              const adapterApiCredentials = apiCredentials
                .filter((c) => c.oisTitle === oisTitle)
                .map((c) => node.utils.removeKey(c, "oisTitle"));

              const options: adapter.BuildRequestOptions = {
                ois: configOis,
                endpointName,
                parameters: sanitizedParameters,
                apiCredentials:
                  adapterApiCredentials as adapter.ApiCredentials[],
                metadata: null,
              };

              const [errBuildAndExecuteRequest, apiResponse] = await retryGo(
                () => adapter.buildAndExecuteRequest(options)
              );
              if (
                errBuildAndExecuteRequest ||
                isNil(apiResponse) ||
                isNil(apiResponse.data)
              ) {
                node.logger.error(
                  `failed to fetch data from API for endpoint: ${endpointName}`,
                  {
                    ...beaconIdLogOptions,
                    error: errBuildAndExecuteRequest,
                  }
                );
                continue;
              }
              node.logger.info(
                `API server response data: ${JSON.stringify(apiResponse.data)}`,
                beaconIdLogOptions
              );

              let apiValue: ethers.BigNumber;
              try {
                const response = adapter.extractAndEncodeResponse(
                  apiResponse.data,
                  reservedParameters as adapter.ReservedParameters
                );
                apiValue = ethers.BigNumber.from(response.values[0].toString());
              } catch (error) {
                node.logger.error(
                  `failed to extract or encode value from API response: ${JSON.stringify(
                    apiResponse.data
                  )}`,
                  { ...beaconIdLogOptions, error: error as any }
                );
                continue;
              }
              node.logger.info(
                `API server value: ${apiValue.toString()}`,
                beaconIdLogOptions
              );

              // **************************************************************************
              // 6. Check deviation
              // **************************************************************************
              node.logger.debug("checking deviation...", beaconIdLogOptions);
              let beaconValue = beaconResponse.value;
              const delta = beaconValue.sub(apiValue).abs();
              if (delta.eq(0)) {
                node.logger.warn(
                  "beacon is up-to-date. skipping update",
                  beaconIdLogOptions
                );
                continue;
              }

              beaconValue = beaconResponse.value.isZero()
                ? ethers.constants.One
                : beaconResponse.value;
              const basisPoints = ethers.utils.parseUnits("1", 16);
              const deviation = delta
                .mul(basisPoints)
                .mul(100)
                .div(beaconValue);
              node.logger.info(
                `deviation (%): ${ethers.utils.formatUnits(deviation, 16)}`,
                beaconIdLogOptions
              );

              // **************************************************************************
              // 7. Update beacon if necessary (call makeRequest)
              // **************************************************************************
              const percentageThreshold = basisPoints.mul(
                Number(deviationPercentage) * 100 // support for percentages up to 2 decimal places
              );
              if (deviation.lte(percentageThreshold.div(100))) {
                node.logger.warn(
                  "delta between beacon value and api value is within threshold. skipping update",
                  beaconIdLogOptions
                );
                continue;
              }
              node.logger.debug("updating beacon...", beaconIdLogOptions);
              /**
               * 1. Airnode must first call setSponsorshipStatus(rrpBeaconServer.address, true) to
               *    enable the beacon server to make requests to AirnodeRrp
               * 2. Request sponsor should then call setUpdatePermissionStatus(keeperSponsorWallet.address, true)
               *    to allow requester to update beacon
               */

              const requestSponsorWallet = node.evm.deriveSponsorWallet(
                airnodeHDNode,
                requestSponsor
              );

              // Check to prevent sending the same request for beacon update more than once
              // by checking if a RequestedBeaconUpdate event was emitted but no matching
              // UpdatedBeacon event was emitted.

              // 1. Fetch RequestedBeaconUpdate events by beaconId, sponsor and sponsorWallet
              const requestedBeaconUpdateFilter =
                rrpBeaconServer.filters.RequestedBeaconUpdate(
                  beaconId,
                  requestSponsor,
                  keeperSponsorWallet.address
                );
              const [
                errRequestedBeaconUpdateFilter,
                requestedBeaconUpdateEvents,
              ] = await retryGo(() =>
                rrpBeaconServer.queryFilter(
                  requestedBeaconUpdateFilter,
                  blockHistoryLimit * -1,
                  currentBlock
                )
              );
              if (
                errRequestedBeaconUpdateFilter ||
                isNil(requestedBeaconUpdateEvents)
              ) {
                node.logger.error(
                  "failed to fetch RequestedBeaconUpdate events",
                  {
                    ...beaconIdLogOptions,
                    error: errRequestedBeaconUpdateFilter,
                  }
                );
                continue;
              }

              // 2. Fetch UpdatedBeacon events by beaconId
              const updatedBeaconFilter =
                rrpBeaconServer.filters.UpdatedBeacon(beaconId);
              const [errUpdatedBeaconFilter, updatedBeaconEvents] =
                await retryGo(() =>
                  rrpBeaconServer.queryFilter(
                    updatedBeaconFilter,
                    blockHistoryLimit * -1,
                    currentBlock
                  )
                );
              if (errUpdatedBeaconFilter || isNil(updatedBeaconEvents)) {
                node.logger.error("failed to fetch UpdatedBeacon events", {
                  ...beaconIdLogOptions,
                  error: errUpdatedBeaconFilter,
                });
                continue;
              }

              // 3. Match these events by requestId and unmatched events
              //    are the ones that are still waiting to be fulfilled
              const [pendingRequestedBeaconUpdateEvent] =
                requestedBeaconUpdateEvents.filter(
                  (rbue) =>
                    !updatedBeaconEvents.some(
                      (ub) => rbue.args!["requestId"] === ub.args!["requestId"]
                    )
                );
              if (!isNil(pendingRequestedBeaconUpdateEvent)) {
                // 4. Check if RequestedBeaconUpdate event is awaiting fulfillment by
                //    calling AirnodeRrp.requestIsAwaitingFulfillment with requestId
                //    and check if beacon value is fresh enough and skip if it is
                const [
                  errRequestIsAwaitingFulfillment,
                  requestIsAwaitingFulfillment,
                ] = await retryGo(() =>
                  airnodeRrp.requestIsAwaitingFulfillment(
                    pendingRequestedBeaconUpdateEvent.args!["requestId"]
                  )
                );
                if (errRequestIsAwaitingFulfillment) {
                  node.logger.error(
                    "failed to check if request is awaiting fulfillment",
                    {
                      ...beaconIdLogOptions,
                      error: errRequestIsAwaitingFulfillment,
                    }
                  );
                  continue;
                }
                if (requestIsAwaitingFulfillment) {
                  node.logger.warn(
                    "request is awaiting fulfillment. skipping update",
                    beaconIdLogOptions
                  );
                  continue;
                }
              }

              // Fetch current gas fee data
              const [gasPriceLogs, gasTarget] = await getGasPrice({
                provider,
                chainOptions: chain.options,
              });
              if (!isEmpty(gasPriceLogs)) {
                node.logger.logPending(gasPriceLogs, beaconIdLogOptions);
              }
              if (!gasTarget) {
                node.logger.error(
                  "unable to submit transactions without gas price. skipping update",
                  beaconIdLogOptions
                );
                continue;
              }

              // Submit requestBeaconUpdate transaction
              const currentNonce = nonce;
              const [errRequestBeaconUpdate] = await retryGo(() =>
                rrpBeaconServer
                  .connect(keeperSponsorWallet)
                  .requestBeaconUpdate(
                    templateId,
                    requestSponsor,
                    requestSponsorWallet.address,
                    encodedParameters,
                    {
                      gasLimit: GAS_LIMIT,
                      ...gasTarget,
                      nonce: nonce++,
                    }
                  )
              );
              if (errRequestBeaconUpdate) {
                node.logger.error(
                  `failed to submit transaction using wallet ${keeperSponsorWallet.address} with nonce ${currentNonce}. skipping update`,
                  {
                    ...beaconIdLogOptions,
                    error: errRequestBeaconUpdate,
                  }
                );
              }
            }
          }
        );

        await Promise.all(keeperSponsorWalletPromises);
      });
    })
  );

  await Promise.all(providerPromises);

  const completedAt = new Date();
  const durationMs = Math.abs(completedAt.getTime() - startedAt.getTime());
  node.logger.info(
    `Airkeeper finished at ${node.utils.formatDateTime(
      completedAt
    )}. Total time: ${durationMs}ms`,
    baseLogOptions
  );

  const response = {
    ok: true,
    data: { message: "Airkeeper invocation has finished" },
  };
  return { statusCode: 200, body: JSON.stringify(response) };
};
