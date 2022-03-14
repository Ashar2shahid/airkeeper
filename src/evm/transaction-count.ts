import * as node from '@api3/airnode-node';
import { ethers } from 'ethers';
import isNil from 'lodash/isNil';
import { SponsorWalletTransactionCount } from '../types';
import { retryGo } from '../utils';
import { deriveSponsorWallet, shortenAddress } from '../wallet';

// TODO: should this be in a centralized enum somewhere (api3/airnode-protocol maybe)?
const pspProtocolId = '2';

export const getSponsorWalletAndTransactionCount = async (
  airnodeWallet: ethers.Wallet,
  provider: ethers.providers.Provider,
  currentBlock: number,
  sponsor: string
): Promise<node.LogsData<SponsorWalletTransactionCount | null>> => {
  // Derive sponsorWallet address
  // TODO: switch to node.evm.deriveSponsorWallet when @api3/airnode-node allows setting the `protocolId`
  const sponsorWallet = deriveSponsorWallet(airnodeWallet.mnemonic.phrase, sponsor, pspProtocolId).connect(provider);

  // Fetch sponsorWallet transaction count
  const [errorGetTransactionCount, transactionCount] = await retryGo(() =>
    provider.getTransactionCount(sponsorWallet.address, currentBlock)
  );
  if (errorGetTransactionCount || isNil(transactionCount)) {
    const message = 'Failed to fetch the sponsor wallet transaction count';
    const log = node.logger.pend('ERROR', message, errorGetTransactionCount);
    return [[log], null];
  }

  const message = `Sponsor wallet ${shortenAddress(sponsorWallet.address)} transaction count: ${transactionCount}`;
  const log = node.logger.pend('INFO', message, errorGetTransactionCount);
  return [[log], { sponsorWallet, transactionCount }];
};
