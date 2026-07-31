export type TossApiAuthConfig =
  | {
    tossApiAuthMode: "oauth_client_credentials";
    clientId: string;
    clientSecret: string;
    tossApiBearerToken?: undefined;
  }
  | {
    tossApiAuthMode: "static_bearer";
    clientId?: string;
    clientSecret?: string;
    tossApiBearerToken: string;
  };

export type TossClientConfig = TossApiAuthConfig & {
  tossApiBaseUrl: string;
};
