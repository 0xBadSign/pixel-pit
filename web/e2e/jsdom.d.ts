// Minimal typing for the one jsdom use in e2e/anvil.test.ts (a document for renderBattery under the node
// environment). jsdom ships no types; @types/jsdom is not worth a dependency for this.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}
