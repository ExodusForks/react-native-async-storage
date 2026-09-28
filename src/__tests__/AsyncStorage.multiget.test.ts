import { describe, expect, it, jest } from '@jest/globals';

import type { AsyncStorageStatic, ErrorLike } from '../types';

type NativeCallback = (errors?: ErrorLike[], result?: string[][]) => void;

type Harness = {
  AsyncStorage: AsyncStorageStatic;
  /** Keys handed to the native module, one entry per native multiGet call. */
  batches: string[][];
};

function createHarness(
  store: Record<string, string> = {},
  failWith?: ErrorLike
): Harness {
  const batches: string[][] = [];

  const native = {
    multiGet: (keys: string[], callback: NativeCallback) => {
      batches.push([...keys]);

      if (failWith) {
        callback([failWith], undefined);
        return;
      }

      const result = keys
        .filter((key) => Object.prototype.hasOwnProperty.call(store, key))
        .map((key) => [key, store[key] as string]);

      callback(undefined, result);
    },
  };

  jest.resetModules();
  jest.doMock('../RCTAsyncStorage', () => ({
    __esModule: true,
    default: native,
  }));

  const AsyncStorage = (
    require('../AsyncStorage.native') as { default: AsyncStorageStatic }
  ).default;

  return { AsyncStorage, batches };
}

/**
 * The dedupe algorithm this module used before it was indexed with a Set. The
 * differential test below pins the new implementation to this output.
 */
function originalDedupe(requests: string[][]): string[] {
  const accumulated: string[] = [];

  for (const keys of requests) {
    keys.forEach((key) => {
      if (accumulated.indexOf(key) === -1) {
        accumulated.push(key);
      }
    });
  }

  return accumulated;
}

function createRng(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('multiGet key batching', () => {
  it('fetches each key once across calls coalesced into one batch', async () => {
    const { AsyncStorage, batches } = createHarness({
      a: '1',
      b: '2',
      c: '3',
    });

    await Promise.all([
      AsyncStorage.multiGet(['a', 'b']),
      AsyncStorage.multiGet(['b', 'c']),
    ]);

    expect(batches).toEqual([['a', 'b', 'c']]);
  });

  it('fetches each key once when a single call repeats it', async () => {
    const { AsyncStorage, batches } = createHarness({ a: '1', b: '2' });

    await AsyncStorage.multiGet(['a', 'a', 'b', 'a']);

    expect(batches).toEqual([['a', 'b']]);
  });

  it('keeps keys in first-seen order', async () => {
    const { AsyncStorage, batches } = createHarness();

    await Promise.all([
      AsyncStorage.multiGet(['z', 'm']),
      AsyncStorage.multiGet(['m', 'a', 'z', 'b']),
    ]);

    expect(batches).toEqual([['z', 'm', 'a', 'b']]);
  });

  it('re-fetches a key in a later batch', async () => {
    const { AsyncStorage, batches } = createHarness({ a: '1' });

    await AsyncStorage.multiGet(['a']);
    await AsyncStorage.multiGet(['a']);

    expect(batches).toEqual([['a'], ['a']]);
  });

  it('re-fetches keys after an explicit flush', async () => {
    const { AsyncStorage, batches } = createHarness({ a: '1', b: '2' });

    const first = AsyncStorage.multiGet(['a', 'b']);
    AsyncStorage.flushGetRequests();
    await first;

    const second = AsyncStorage.multiGet(['b', 'a']);
    AsyncStorage.flushGetRequests();
    await second;

    expect(batches).toEqual([
      ['a', 'b'],
      ['b', 'a'],
    ]);
  });

  it('gives every caller the keys it asked for, in its own order', async () => {
    const { AsyncStorage } = createHarness({ a: '1', b: '2', c: '3' });

    const [first, second] = await Promise.all([
      AsyncStorage.multiGet(['a', 'b']),
      AsyncStorage.multiGet(['c', 'b']),
    ]);

    expect(first).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(second).toEqual([
      ['c', '3'],
      ['b', '2'],
    ]);
  });

  it('repeats a value for a caller that asked for the same key twice', async () => {
    const { AsyncStorage } = createHarness({ a: '1' });

    const result = await AsyncStorage.multiGet(['a', 'a']);

    expect(result).toEqual([
      ['a', '1'],
      ['a', '1'],
    ]);
  });

  it('reports missing keys as undefined values', async () => {
    const { AsyncStorage } = createHarness({ a: '1' });

    const result = await AsyncStorage.multiGet(['a', 'missing']);

    expect(result).toEqual([
      ['a', '1'],
      ['missing', undefined],
    ]);
  });

  it('invokes the caller callback alongside the promise', async () => {
    const { AsyncStorage } = createHarness({ a: '1' });
    const seen: unknown[] = [];

    await AsyncStorage.multiGet(['a'], (errors, result) => {
      seen.push(errors, result);
    });

    expect(seen).toEqual([null, [['a', '1']]]);
  });

  it('rejects every request in a failed batch', async () => {
    const { AsyncStorage } = createHarness(
      {},
      { message: 'native boom', key: 'a' }
    );

    const first = AsyncStorage.multiGet(['a']);
    const second = AsyncStorage.multiGet(['b']);

    await expect(first).rejects.toThrow('native boom');
    await expect(second).rejects.toThrow('native boom');
  });

  it('dedupes a batch far larger than the accumulator it replaced', async () => {
    const { AsyncStorage, batches } = createHarness();
    const keys = Array.from({ length: 5000 }, (_, i) => `key_${i}`);

    await Promise.all([
      AsyncStorage.multiGet(keys),
      AsyncStorage.multiGet(keys),
      AsyncStorage.multiGet([...keys].reverse()),
    ]);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(keys);
  });

  it('accumulates exactly what the pre-Set implementation accumulated', async () => {
    const random = createRng(20260928);
    const alphabet = Array.from({ length: 12 }, (_, i) => `k${i}`);

    for (let round = 0; round < 40; round++) {
      const requests = Array.from(
        { length: 1 + Math.floor(random() * 5) },
        () =>
          Array.from(
            { length: 1 + Math.floor(random() * 8) },
            () => alphabet[Math.floor(random() * alphabet.length)] as string
          )
      );

      const { AsyncStorage, batches } = createHarness();

      await Promise.all(requests.map((keys) => AsyncStorage.multiGet(keys)));

      expect(batches).toEqual([originalDedupe(requests)]);
    }
  });
});
