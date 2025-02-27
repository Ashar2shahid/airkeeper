import { mockReadFileSync } from '../mock-utils';
import { ContractFactory, Contract } from 'ethers';
import * as hre from 'hardhat';
import * as abi from '@api3/airnode-abi';
import * as node from '@api3/airnode-node';
import {
  AccessControlRegistry__factory as AccessControlRegistryFactory,
  AirnodeProtocol__factory as AirnodeProtocolFactory,
  DapiServer__factory as DapiServerFactory,
} from '@api3/airnode-protocol-v1';
import * as psp from '../../src/handlers/psp';
import * as api from '../../src/api/call-api';
import * as config from '../../src/config';
import { buildAirnodeConfig, buildAirkeeperConfig, buildLocalConfigETH, buildLocalConfigBTC } from '../config/config';
import { PROTOCOL_ID_PSP } from '../../src/constants';

// Jest version 27 has a bug where jest.setTimeout does not work correctly inside describe or test blocks
// https://github.com/facebook/jest/issues/11607
jest.setTimeout(30_000);

const dapiServerAdminRoleDescription = 'DapiServer admin';
const subscriptionIdBTC = '0xb4c3cea3b78c384eb4409df1497bb2f1fd872f1928a218f8907c38fe0d66ffea';
const provider = new hre.ethers.providers.JsonRpcProvider('http://127.0.0.1:8545');

process.env = Object.assign(process.env, {
  CLOUD_PROVIDER: 'local',
  STAGE: 'dev',
});

const airnodeConfig = buildAirnodeConfig();
const airkeeperConfig = buildAirkeeperConfig();
const localConfigETH = buildLocalConfigETH();

const roles = {
  deployer: new hre.ethers.Wallet(localConfigETH.privateKeys.deployer).connect(provider),
  manager: new hre.ethers.Wallet(localConfigETH.privateKeys.manager).connect(provider),
  sponsor: new hre.ethers.Wallet(localConfigETH.privateKeys.sponsor).connect(provider),
  randomPerson: new hre.ethers.Wallet(localConfigETH.privateKeys.randomPerson).connect(provider),
};

const readBeaconValue = async (airnodeAddress: string, templateId: string, dapiServer: Contract) => {
  const voidSigner = new hre.ethers.VoidSigner(hre.ethers.constants.AddressZero, provider);
  const beaconId = hre.ethers.utils.keccak256(
    hre.ethers.utils.solidityPack(['address', 'bytes32'], [airnodeAddress, templateId])
  );

  try {
    return await dapiServer.connect(voidSigner).readDataFeedValueWithId(beaconId);
  } catch (e) {
    return null;
  }
};

describe('PSP', () => {
  let accessControlRegistryFactory: ContractFactory;
  let accessControlRegistry: Contract;
  let airnodeProtocolFactory: ContractFactory;
  let airnodeProtocol: Contract;
  let dapiServerFactory: ContractFactory;
  let dapiServer: Contract;
  let templateIdETH: string;
  let templateIdBTC: string;

  beforeEach(async () => {
    // Reset the local hardhat network state for each test to keep the deployed Airnode and DapiServer contract addresses
    // the same as the config files
    await hre.network.provider.send('hardhat_reset');

    jest.restoreAllMocks();

    // Deploy contracts
    accessControlRegistryFactory = new hre.ethers.ContractFactory(
      AccessControlRegistryFactory.abi,
      AccessControlRegistryFactory.bytecode,
      roles.deployer
    );
    accessControlRegistry = await accessControlRegistryFactory.deploy();

    airnodeProtocolFactory = new hre.ethers.ContractFactory(
      AirnodeProtocolFactory.abi,
      AirnodeProtocolFactory.bytecode,
      roles.deployer
    );
    airnodeProtocol = await airnodeProtocolFactory.deploy();

    dapiServerFactory = new hre.ethers.ContractFactory(
      DapiServerFactory.abi,
      DapiServerFactory.bytecode,
      roles.deployer
    );
    dapiServer = await dapiServerFactory.deploy(
      accessControlRegistry.address,
      dapiServerAdminRoleDescription,
      roles.manager.address,
      airnodeProtocol.address
    );

    // Access control
    const managerRootRole = await accessControlRegistry.deriveRootRole(roles.manager.address);
    await accessControlRegistry
      .connect(roles.manager)
      .initializeRoleAndGrantToSender(managerRootRole, dapiServerAdminRoleDescription);

    // Wallets
    const airnodeWallet = hre.ethers.Wallet.fromMnemonic(localConfigETH.airnodeMnemonic);
    const airnodePspSponsorWallet = node.evm
      .deriveSponsorWalletFromMnemonic(localConfigETH.airnodeMnemonic, roles.sponsor.address, PROTOCOL_ID_PSP)
      .connect(provider);
    await roles.deployer.sendTransaction({
      to: airnodePspSponsorWallet.address,
      value: hre.ethers.utils.parseEther('1'),
    });

    // Setup ETH Subscription
    // Templates
    const endpointIdETH = hre.ethers.utils.keccak256(
      hre.ethers.utils.defaultAbiCoder.encode(
        ['string', 'string'],
        [localConfigETH.endpoint.oisTitle, localConfigETH.endpoint.endpointName]
      )
    );
    const parametersETH = abi.encode(localConfigETH.templateParameters);
    templateIdETH = hre.ethers.utils.solidityKeccak256(['bytes32', 'bytes'], [endpointIdETH, parametersETH]);

    // Subscriptions
    const thresholdETH = (await dapiServer.HUNDRED_PERCENT()).div(localConfigETH.threshold); // Update threshold %
    const beaconUpdateSubscriptionConditionParametersETH = hre.ethers.utils.defaultAbiCoder.encode(
      ['uint256'],
      [thresholdETH]
    );
    const beaconUpdateSubscriptionConditionsETH = [
      {
        type: 'bytes32',
        name: '_conditionFunctionId',
        value: hre.ethers.utils.defaultAbiCoder.encode(
          ['bytes4'],
          [dapiServer.interface.getSighash('conditionPspBeaconUpdate')]
        ),
      },
      { type: 'bytes', name: '_conditionParameters', value: beaconUpdateSubscriptionConditionParametersETH },
    ];
    const encodedBeaconUpdateSubscriptionConditionsETH = abi.encode(beaconUpdateSubscriptionConditionsETH);
    await dapiServer
      .connect(roles.randomPerson)
      .registerBeaconUpdateSubscription(
        airnodeWallet.address,
        templateIdETH,
        encodedBeaconUpdateSubscriptionConditionsETH,
        airnodeWallet.address,
        roles.sponsor.address
      );

    // Setup BTC Subscription
    const localConfigBTC = buildLocalConfigBTC();
    // Templates
    const endpointIdBTC = hre.ethers.utils.keccak256(
      hre.ethers.utils.defaultAbiCoder.encode(
        ['string', 'string'],
        [localConfigBTC.endpoint.oisTitle, localConfigBTC.endpoint.endpointName]
      )
    );
    const parametersBTC = abi.encode(localConfigBTC.templateParameters);
    templateIdBTC = hre.ethers.utils.solidityKeccak256(['bytes32', 'bytes'], [endpointIdBTC, parametersBTC]);

    // Subscriptions
    const thresholdBTC = (await dapiServer.HUNDRED_PERCENT()).div(localConfigBTC.threshold); // Update threshold %
    const beaconUpdateSubscriptionConditionParameters2 = hre.ethers.utils.defaultAbiCoder.encode(
      ['uint256'],
      [thresholdBTC]
    );
    const beaconUpdateSubscriptionConditionsBTC = [
      {
        type: 'bytes32',
        name: '_conditionFunctionId',
        value: hre.ethers.utils.defaultAbiCoder.encode(
          ['bytes4'],
          [dapiServer.interface.getSighash('conditionPspBeaconUpdate')]
        ),
      },
      { type: 'bytes', name: '_conditionParameters', value: beaconUpdateSubscriptionConditionParameters2 },
    ];
    const encodedBeaconUpdateSubscriptionConditionsBTC = abi.encode(beaconUpdateSubscriptionConditionsBTC);
    await dapiServer
      .connect(roles.randomPerson)
      .registerBeaconUpdateSubscription(
        airnodeWallet.address,
        templateIdBTC,
        encodedBeaconUpdateSubscriptionConditionsBTC,
        airnodeWallet.address,
        roles.sponsor.address
      );
  });

  it('updates the beacons successfully', async () => {
    jest
      .spyOn(config, 'loadAirnodeConfig')
      .mockImplementationOnce(() => airnodeConfig as any)
      .mockImplementationOnce(() => airnodeConfig as any);
    jest.spyOn(config, 'loadAirkeeperConfig').mockImplementationOnce(() => airkeeperConfig as any);
    const res = await psp.handler();

    const beaconValueETH = await readBeaconValue(airkeeperConfig.airnodeAddress, templateIdETH, dapiServer);
    const beaconValueBTC = await readBeaconValue(airkeeperConfig.airnodeAddress, templateIdBTC, dapiServer);

    expect(beaconValueETH).toEqual(hre.ethers.BigNumber.from(723.39202 * 1_000_000));
    expect(beaconValueBTC).toEqual(hre.ethers.BigNumber.from(41091.12345 * 1_000_000));
    expect(res).toEqual({
      statusCode: 200,
      body: JSON.stringify({ ok: true, data: { message: 'PSP beacon update execution has finished' } }),
    });
  });

  it('updates the beacons successfully after retrying a failed api call', async () => {
    jest
      .spyOn(config, 'loadAirnodeConfig')
      .mockImplementationOnce(() => airnodeConfig as any)
      .mockImplementationOnce(() => airnodeConfig as any);
    jest.spyOn(config, 'loadAirkeeperConfig').mockImplementationOnce(() => airkeeperConfig as any);

    const callApiSpy = jest.spyOn(api, 'callApi');
    callApiSpy.mockRejectedValueOnce(new Error('Api call failed'));

    const res = await psp.handler();

    const beaconValueETH = await readBeaconValue(airkeeperConfig.airnodeAddress, templateIdETH, dapiServer);
    const beaconValueBTC = await readBeaconValue(airkeeperConfig.airnodeAddress, templateIdBTC, dapiServer);

    expect(beaconValueETH).toEqual(hre.ethers.BigNumber.from(723.39202 * 1_000_000));
    expect(beaconValueBTC).toEqual(hre.ethers.BigNumber.from(41091.12345 * 1_000_000));
    expect(res).toEqual({
      statusCode: 200,
      body: JSON.stringify({ ok: true, data: { message: 'PSP beacon update execution has finished' } }),
    });
  });

  it('updates the beacons successfully with one invalid provider present', async () => {
    jest.spyOn(config, 'loadAirnodeConfig').mockImplementation(
      () =>
        ({
          ...airnodeConfig,
          chains: [
            ...airnodeConfig.chains,
            {
              ...airnodeConfig.chains[0],
              providers: {
                ...airnodeConfig.chains[0].providers,
                invalidProvider: {
                  url: 'http://invalid',
                },
              },
            },
          ],
        } as any)
    );
    jest.spyOn(config, 'loadAirkeeperConfig').mockImplementationOnce(() => airkeeperConfig);

    const res = await psp.handler();

    const beaconValueETH = await readBeaconValue(airkeeperConfig.airnodeAddress, templateIdETH, dapiServer);
    const beaconValueBTC = await readBeaconValue(airkeeperConfig.airnodeAddress, templateIdBTC, dapiServer);

    expect(beaconValueETH).toEqual(hre.ethers.BigNumber.from(723.39202 * 1_000_000));
    expect(beaconValueBTC).toEqual(hre.ethers.BigNumber.from(41091.12345 * 1_000_000));
    expect(res).toEqual({
      statusCode: 200,
      body: JSON.stringify({ ok: true, data: { message: 'PSP beacon update execution has finished' } }),
    });
  });

  it('updates the beacon successfully with one invalid subscription present', async () => {
    jest
      .spyOn(config, 'loadAirnodeConfig')
      .mockImplementationOnce(() => airnodeConfig as any)
      .mockImplementationOnce(() => airnodeConfig as any);
    jest.spyOn(config, 'loadAirkeeperConfig').mockImplementationOnce(() => ({
      ...airkeeperConfig,
      subscriptions: {
        ...airkeeperConfig.subscriptions,
        [subscriptionIdBTC]: {
          ...airkeeperConfig.subscriptions[subscriptionIdBTC],
          fulfillFunctionId: '0x206b48fa', // invalid fulfillFunctionId
        },
      },
    }));

    const res = await psp.handler();

    const beaconValueETH = await readBeaconValue(airkeeperConfig.airnodeAddress, templateIdETH, dapiServer);
    const beaconValueBTC = await readBeaconValue(airkeeperConfig.airnodeAddress, templateIdBTC, dapiServer);

    expect(beaconValueETH).toEqual(hre.ethers.BigNumber.from(723.39202 * 1_000_000));
    expect(beaconValueBTC).toEqual(null);
    expect(res).toEqual({
      statusCode: 200,
      body: JSON.stringify({ ok: true, data: { message: 'PSP beacon update execution has finished' } }),
    });
  });

  it('throws on invalid airnode config', async () => {
    mockReadFileSync(
      'config.json',
      JSON.stringify({
        ...airnodeConfig,
        nodeSettings: { ...airnodeConfig.nodeSettings, airnodeWalletMnemonic: null },
      })
    );
    mockReadFileSync('airkeeper.json', JSON.stringify(airkeeperConfig));
    await expect(psp.handler).rejects.toThrow('Invalid Airnode configuration file');
  });

  it('throws on invalid airkeeper config', async () => {
    mockReadFileSync('config.json', JSON.stringify(airnodeConfig));
    mockReadFileSync('airkeeper.json', JSON.stringify({ ...airkeeperConfig, airnodeAddress: null }));
    await expect(psp.handler).rejects.toThrow('Invalid Airkeeper configuration file');
  });
});
