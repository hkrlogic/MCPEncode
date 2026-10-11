import type { OAuthMetadata } from "@modelcontextprotocol/server";

type Discovery = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
  grant_types_supported?: string[];
  subject_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
};

/** RFC 8414 plus the OpenID Discovery fields Cursor requires to connect. */
export type AuthServerMetadata = OAuthMetadata & {
  jwks_uri?: string;
  registration_endpoint?: string;
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  subject_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
};

export type AuthServerEndpoints = {
  metadata: AuthServerMetadata;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint?: string;
};

export async function loadAuthServer(issuer: string): Promise<AuthServerEndpoints> {
  const urls = [
    `${issuer}/.well-known/openid-configuration`,
    `${issuer}/.well-known/oauth-authorization-server`,
  ];
  let discovery: Discovery | undefined;
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        discovery = (await response.json()) as Discovery;
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (!discovery?.authorization_endpoint || !discovery.token_endpoint || !discovery.issuer) {
    throw new Error(
      `Could not load OAuth discovery from ${issuer}. Leave AUTH_MODE unset to use the built-in sign-in.`,
      { cause: lastError },
    );
  }

  const metadata: AuthServerMetadata = {
    issuer: discovery.issuer,
    authorization_endpoint: discovery.authorization_endpoint,
    token_endpoint: discovery.token_endpoint,
    response_types_supported: discovery.response_types_supported ?? ["code"],
    code_challenge_methods_supported: discovery.code_challenge_methods_supported ?? ["S256"],
    scopes_supported: discovery.scopes_supported?.length
      ? discovery.scopes_supported
      : ["openid"],
    jwks_uri: discovery.jwks_uri,
    grant_types_supported: discovery.grant_types_supported ?? ["authorization_code"],
    token_endpoint_auth_methods_supported: discovery.token_endpoint_auth_methods_supported ?? ["none"],
    subject_types_supported: discovery.subject_types_supported ?? ["public"],
    id_token_signing_alg_values_supported: discovery.id_token_signing_alg_values_supported ?? ["RS256"],
  };

  return {
    metadata,
    authorizationEndpoint: discovery.authorization_endpoint,
    tokenEndpoint: discovery.token_endpoint,
    endSessionEndpoint: discovery.end_session_endpoint,
  };
}
