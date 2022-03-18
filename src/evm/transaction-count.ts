import * as node from '@api3/airnode-node';
import { logger } from '@api3/airnode-utilities';
import { ethers } from 'ethers';
import isNil from 'lodash/isNil';
import { SponsorWalletTransactionCount } from '../types';
import { retryGo } from '../utils';
import { shortenAddress } from '../wallet';

export const getSponsorWalletAndTransactionCount = async (
  airnodeWallet: ethers.Wallet,
  provider: ethers.providers.Provider,
  currentBlock: number,
  sponsor: string
): Promise<node.LogsData<SponsorWalletTransactionCount | null>> => {
  // Derive sponsorWallet address
  // TODO: switch to node.evm.deriveSponsorWallet when @api3/airnode-node allows setting the `protocolId`
  const sponsorWallet = node.evm
    .deriveSponsorWalletFromMnemonic(airnodeWallet.mnemonic.phrase, sponsor, '2')
    .connect(provider);

  // Fetch sponsorWallet transaction count
  const [errorGetTransactionCount, transactionCount] = await retryGo(() =>
    provider.getTransactionCount(sponsorWallet.address, currentBlock)
  );
  if (errorGetTransactionCount || isNil(transactionCount)) {
    const message = 'Failed to fetch the sponsor wallet transaction count';
    const log = logger.pend('ERROR', message, errorGetTransactionCount);
    return [[log], null];
  }

  const message = `Sponsor wallet ${shortenAddress(sponsorWallet.address)} transaction count: ${transactionCount}`;
  const log = logger.pend('INFO', message, errorGetTransactionCount);
  return [[log], { sponsorWallet, transactionCount }];
};
