export {};

declare global {
  interface Window {
    yueyeDesktop?: {
      onPrepareClose(callback: () => Promise<void>): () => void;
    };
  }
}
