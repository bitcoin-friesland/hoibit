/**
 * Runs the given tasks one after another, in call order. A failing task rejects
 * its own promise but does not stop the tasks queued after it.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}
