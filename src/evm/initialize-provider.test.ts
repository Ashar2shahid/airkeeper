import { ethers } from 'ethers';
import { initializeProvider } from './initialize-provider';
import { BASE_FEE_MULTIPLIER, PRIORITY_FEE_IN_WEI } from '../constants';
import { ChainConfig } from '../types';

describe('initializeProvider', () => {
  beforeEach(() => jest.restoreAllMocks());

  const chain: ChainConfig = {
    maxConcurrency: 100,
    authorizers: [],
    contracts: {
      AirnodeRrp: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      RrpBeaconServer: '0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e',
      DapiServer: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    },
    id: '31337',
    providers: { local: { url: 'http://127.0.0.1:8545' } },
    type: 'evm',
    options: {
      txType: 'eip1559',
      baseFeeMultiplier: 2,
      priorityFee: { value: 3.12, unit: 'gwei' },
    },
  };
  const providerUrl = 'http://localhost:8545';

  it('should initialize provider', async () => {
    const getBlockNumberSpy = jest.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlockNumber');
    const currentBlock = Math.floor(Date.now() / 1000);
    getBlockNumberSpy.mockResolvedValueOnce(currentBlock);

    const { gasTarget, blockSpy, gasPriceSpy } = createAndMockGasTarget('eip1559');

    const [logs, data] = await initializeProvider(chain, providerUrl);

    expect(getBlockNumberSpy).toHaveBeenCalled();
    expect(blockSpy).toHaveBeenCalled();
    expect(gasPriceSpy).not.toHaveBeenCalled();
    expect(logs).toEqual(
      expect.arrayContaining([
        { level: 'INFO', message: `Current block number for chainId 31337: ${currentBlock}` },
        {
          level: 'INFO',
          message: `Gas target for chainId 31337: ${JSON.stringify(gasTarget)}`,
        },
      ])
    );
    expect(data).toEqual(
      expect.objectContaining({
        provider: expect.any(ethers.providers.JsonRpcProvider),
        contracts: expect.objectContaining({
          RrpBeaconServer: expect.any(ethers.Contract),
          DapiServer: expect.any(ethers.Contract),
        }),
        voidSigner: expect.any(ethers.VoidSigner),
        currentBlock,
        gasTarget,
      })
    );
  });

  it('returns null with error log if current block cannot be fetched', async () => {
    const getBlockNumberSpy = jest.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlockNumber');
    const errorMessage = 'could not detect network (event="noNetwork", code=NETWORK_ERROR, version=providers/5.5.3)';
    getBlockNumberSpy.mockRejectedValueOnce(new Error(errorMessage));

    const { blockSpy, gasPriceSpy } = createAndMockGasTarget('eip1559');

    const [logs, data] = await initializeProvider(chain, providerUrl);

    expect(blockSpy).not.toHaveBeenCalled();
    expect(gasPriceSpy).not.toHaveBeenCalled();
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('could not detect network') }),
          level: 'ERROR',
          message: 'Failed to fetch the blockNumber',
        }),
      ])
    );
    expect(data).toEqual(null);
  });

  it('returns null with error log if gas target cannot be fetched', async () => {
    const getBlockNumberSpy = jest.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlockNumber');
    const currentBlock = Math.floor(Date.now() / 1000);
    getBlockNumberSpy.mockResolvedValueOnce(currentBlock);

    const gasPriceSpy = jest.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getGasPrice');
    const errorMessage = 'could not detect network (event="noNetwork", code=NETWORK_ERROR, version=providers/5.5.3)';
    gasPriceSpy.mockRejectedValueOnce(new Error(errorMessage));
    const blockSpy = jest.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlock');
    blockSpy.mockRejectedValueOnce(new Error(errorMessage));

    const [logs, data] = await initializeProvider(chain, providerUrl);

    expect(getBlockNumberSpy).toHaveBeenCalled();
    expect(logs).toEqual(expect.arrayContaining([{ level: 'ERROR', message: 'Failed to fetch gas price' }]));
    expect(data).toEqual(null);
  });
});

/**
 * Creates and mocks gas pricing-related resources based on txType.
 */
const createAndMockGasTarget = (txType: 'legacy' | 'eip1559') => {
  const gasPriceSpy = jest.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getGasPrice');
  const blockSpy = jest.spyOn(ethers.providers.JsonRpcProvider.prototype, 'getBlock');
  if (txType === 'legacy') {
    const gasPrice = ethers.BigNumber.from(1000);
    gasPriceSpy.mockResolvedValue(gasPrice);
    return { gasTarget: { gasPrice }, blockSpy, gasPriceSpy };
  }

  const baseFeePerGas = ethers.BigNumber.from(1000);
  blockSpy.mockResolvedValue({ baseFeePerGas } as ethers.providers.Block);
  const maxPriorityFeePerGas = ethers.BigNumber.from(PRIORITY_FEE_IN_WEI);
  const maxFeePerGas = baseFeePerGas.mul(BASE_FEE_MULTIPLIER).add(maxPriorityFeePerGas);

  return { gasTarget: { maxPriorityFeePerGas, maxFeePerGas }, blockSpy, gasPriceSpy };
};
