/**
 * Tear down the devnet that `scripts/up.ts` last ran against, and nothing
 * else.
 *
 * `up` records what it read: the kurtosis enclave's UUID (cold start) or the
 * snapshot's compose file (snapshot mode). `down` removes exactly that, so
 * it can never remove a different enclave that happens to share the name,
 * another compose project, or any container the harness did not use. With
 * no record there is nothing to remove, and it says so.
 *
 * It never starts a kurtosis engine: with no engine running, the enclave
 * cannot be removed, so it reports that and leaves the record in place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { clearTeardownRecord, readTeardownRecord, removeEnclave } from '../src/kurtosis.ts';

const log = (line: string) => process.stderr.write(`[e2e:down] ${line}\n`);

const record = readTeardownRecord();

if (!record) {
  log('no devnet recorded by `up`; nothing to tear down.');
} else if (record.mode === 'kurtosis') {
  removeEnclave(record.enclaveUuid);
  clearTeardownRecord();
  log(`removed kurtosis enclave ${record.enclaveUuid}.`);
} else if (!existsSync(record.composeFile)) {
  clearTeardownRecord();
  log(`compose file ${record.composeFile} is gone; nothing to tear down.`);
} else {
  execFileSync('docker', ['compose', '--file', record.composeFile, 'down', '--volumes'], {
    stdio: ['ignore', 'inherit', 'inherit']
  });
  clearTeardownRecord();
  log(`stopped the snapshot devnet in ${record.composeFile} and removed its volumes.`);
}
