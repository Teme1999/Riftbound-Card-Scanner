// Keep each accepted result's immutable frame until its serial export finishes.
export class ScanDebugQueue {
  constructor(onSize = () => {}) { this.jobs = new Map(); this.waiting = []; this.running = false; this.onSize = onSize; }
  get size() { return this.jobs.size; }
  enqueue(id, run) {
    if (this.jobs.has(id)) return this.jobs.get(id).promise;
    let resolve;
    const promise = new Promise(done => resolve = done), job = { id, run, promise, resolve };
    this.jobs.set(id, job); this.waiting.push(job); this.onSize(this.size); this.pump();
    return promise;
  }
  pump() {
    if (this.running || !this.waiting.length) return;
    const job = this.waiting.shift(); this.running = true;
    let pending;
    try { pending = job.run(); } catch (error) { pending = Promise.reject(error); }
    Promise.resolve(pending).catch(error => console.error('[Debug capture]', error)).finally(() => {
      this.jobs.delete(job.id); this.running = false; this.onSize(this.size); job.resolve(); this.pump();
    });
  }
}
