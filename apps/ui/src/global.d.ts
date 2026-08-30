import type { ZeoApi } from "@zeo/core";

declare global {
  interface Window {
    zeo: ZeoApi;
  }
}

export {};
