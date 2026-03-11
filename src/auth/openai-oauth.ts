import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

const OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_FILE = join(process.cwd(), '.dexter', 'openai-oauth.json');

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

function ensureDexterDir() {
  const dir = join(process.cwd(), '.dexter');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function generateRandomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateCodeVerifier(): string {
  // Codex uses 64 bytes → 86-char URL-safe base64 verifier
  return generateRandomBase64Url(64);
}

async function computeCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export async function loginWithOAuth(): Promise<void> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      port: 1455,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== '/auth/callback') {
          return new Response('Not found', { status: 404 });
        }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          server.stop();
          reject(new Error(`OAuth error: ${error}`));
          return new Response(
            `<html><body><h1>Authentication failed</h1><p>${error}</p><p>You can close this tab.</p></body></html>`,
            { headers: { 'Content-Type': 'text/html' } },
          );
        }

        if (!code) {
          server.stop();
          reject(new Error('No authorization code received'));
          return new Response(
            '<html><body><h1>Error</h1><p>No code received.</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          );
        }

        try {
          const tokenResponse = await fetch(OAUTH_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: CLIENT_ID,
              code,
              redirect_uri: `http://localhost:${server.port}/auth/callback`,
              code_verifier: codeVerifier,
            }),
          });

          if (!tokenResponse.ok) {
            const text = await tokenResponse.text();
            throw new Error(`Token exchange failed: ${tokenResponse.status} ${text}`);
          }

          const data = await tokenResponse.json() as any;
          const tokens: OAuthTokens = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + data.expires_in * 1000,
          };

          ensureDexterDir();
          writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
          console.log('✓ Successfully logged in to OpenAI');

          server.stop();
          resolve();

          return new Response(
            '<html><body><h1>Success!</h1><p>You are now logged in to Dexter via ChatGPT. You can close this tab.</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          );
        } catch (err) {
          server.stop();
          reject(err);
          return new Response(
            `<html><body><h1>Error</h1><p>${err}</p></body></html>`,
            { headers: { 'Content-Type': 'text/html' } },
          );
        }
      },
    });

    const state = generateRandomBase64Url(32);
    const redirectUri = `http://localhost:${server.port}/auth/callback`;
    const authUrl = `${OAUTH_AUTHORIZE_URL}?${new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state,
      originator: 'codex_cli_rs',
    })}`;

    console.log('Opening browser for OpenAI login...');
    console.log(`If the browser doesn't open, visit: ${authUrl}`);

    const openCmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    Bun.spawn([openCmd, authUrl]);
  });
}

export async function getOAuthToken(): Promise<string> {
  if (!existsSync(TOKEN_FILE)) {
    throw new Error('Not logged in to OpenAI. Run `dexter login` first.');
  }

  const tokens: OAuthTokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));

  // Refresh if expiring within 5 minutes
  if (tokens.expires_at - Date.now() < 5 * 60 * 1000) {
    const refreshResponse = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: tokens.refresh_token,
      }),
    });

    if (!refreshResponse.ok) {
      unlinkSync(TOKEN_FILE);
      throw new Error('OAuth token refresh failed. Please run `dexter login` again.');
    }

    const data = await refreshResponse.json() as any;
    const newTokens: OAuthTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    writeFileSync(TOKEN_FILE, JSON.stringify(newTokens, null, 2));
    return newTokens.access_token;
  }

  return tokens.access_token;
}

export function isOAuthLoggedIn(): boolean {
  if (!existsSync(TOKEN_FILE)) return false;
  try {
    const tokens: OAuthTokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
    return !!tokens.access_token;
  } catch {
    return false;
  }
}

export function logoutOAuth(): void {
  if (existsSync(TOKEN_FILE)) {
    unlinkSync(TOKEN_FILE);
    console.log('Logged out from OpenAI.');
  }
}
