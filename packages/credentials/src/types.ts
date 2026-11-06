export type BrowserAuthFile = {
  version: 1;
  secret: string;
};


export type AuthFile = {
  [provider: string]: unknown;
};

export type CredentialStatus =
  | { state: 'missing' }
  | { state: 'configured' }
  | { state: 'error'; message: string };
