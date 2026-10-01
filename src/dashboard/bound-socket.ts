declare module "node:net" {
  export class BoundSocket {
    constructor(options?: { readonly host?: string; readonly port?: number });
    address(): { address: string; family: string; port: number };
    close(): void;
  }
}
