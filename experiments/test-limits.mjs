// The limits widget shows a window, and a window belongs to a Claude account.
// One number for the whole machine was the bug: a project worked on under a
// second account saw the first account's usage, because the snapshot was taken
// from whichever session happened to be awake first.
//
// Offline: the chats here are stand-ins with just the two members the snapshot
// touches — `awake` and `rawUsage()`. No SDK session is started.
import { HostAgent } from '../src/host/agent.js';

let failed = 0;
const check = (cond, name) => {
  if (!cond) {
    console.error('FAIL:', name);
    failed++;
  }
};

const raw = (utilization) => ({
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization, resets_at: null } },
  subscription_type: 'max',
});

/** A project of `profile`, with one stand-in chat per given usage (null = asleep). */
function project(agent, path, chats) {
  agent.projects.set(path, {
    path,
    chats: new Map(
      chats.map((c, i) => [
        String(i),
        {
          awake: c !== null,
          rawUsage: async () => {
            if (c === 'dead') throw new Error('session is gone');
            return raw(c);
          },
        },
      ])
    ),
  });
}

const profiles = { personal: 'personal', work: 'work' };
const agent = new HostAgent();
project(agent, 'P1', [50]); // personal, awake
project(agent, 'W1', [null]); // work, asleep — the account says nothing yet
project(agent, 'W2', [17]); // work, awake in another project of the same account

const profileOf = (path) => (path.startsWith('W') ? profiles.work : profiles.personal);
const byProfile = await agent.limitsByProfile(profileOf);

check(byProfile.personal?.fiveHour.utilization === 50, 'the default account reports its own window');
check(byProfile.work?.fiveHour.utilization === 17, 'the second account reports its own, not the first one’s');
check(
  Object.keys(byProfile).sort().join(',') === 'personal,work',
  'one entry per account, not one per project'
);

// An account with nothing awake is left out entirely: the widget then keeps the
// numbers it had rather than being told this account is at zero.
const asleep = new HostAgent();
project(asleep, 'W1', [null]);
check(Object.keys(await asleep.limitsByProfile(profileOf)).length === 0, 'a sleeping account is absent, not empty');

// A session that died between the check and the call must not lose the account:
// the next chat of the same project is asked.
const flaky = new HostAgent();
project(flaky, 'P1', ['dead', 42]);
check((await flaky.limitsByProfile(profileOf)).personal?.fiveHour.utilization === 42, 'a dead session is stepped over');

// A host with a single account behaves as it always did.
const plain = new HostAgent();
project(plain, 'P1', [80]);
const one = await plain.limitsByProfile(() => 'personal');
check(one.personal?.fiveHour.utilization === 80, 'one account on the host still answers');

console.log(failed ? `${failed} failed` : 'ok');
process.exit(failed ? 1 : 0);
