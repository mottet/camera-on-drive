import axios from 'axios';
import { createHash, randomInt } from 'crypto';
import fs from 'fs/promises';
import puppeteer from 'puppeteer';
import { BehaviorSubject, filter, first, firstValueFrom } from 'rxjs';
import url from 'url';

interface IOAuth2Code {
  codeChallenge: string;
  codeVerifier: string;
}

interface IOAuth2ConnectionPageInfo {
  requestCode: IOAuth2Code;
  requestConnectionUrl: string;
}

interface IOAuth2BaseTokenRequest {
  scope: string,
  redirect_uri: string;
  code_verifier?: string;
  client_id: string;
  client_secret: string;
  grant_type?: string;

  code?: string
  refresh_token?: string
}

enum GrantType {
  NewToken = 'authorization_code',
  RefreshToken = 'refresh_token'
}

interface IOAuth2Tokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
  token_type: string,
  expires_in: number
}

interface IBoschIdCredentials {
  email: string;
  password: string;
}

class OAuth2Tokens implements IOAuth2Tokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;

  expires_at: number;

  public constructor(tokens: IOAuth2Tokens) {
    this.id_token = tokens.id_token;
    this.access_token = tokens.access_token;
    this.refresh_token = tokens.refresh_token;
    this.token_type = tokens.token_type;
    this.expires_in = tokens.expires_in;
    this.expires_at = Date.now() + (this.expires_in * 1000);
  }

  public isValide(): boolean {
    return Date.now() < this.expires_at;
  }
}

export class BoachConnection {

  private TOKEN_PATH = 'bosch-token.json';
  private CREDENTIALS_PATH = 'bosch-credentials.json';
  private _tokens?: OAuth2Tokens | undefined;
  public get tokens(): OAuth2Tokens | undefined {
    return this._tokens;
  }
  private set tokens(value: OAuth2Tokens | undefined) {
    if (value) {
      this._tokens = new OAuth2Tokens(value);
    }
  }
  private baseBodyToRequestTokens: IOAuth2BaseTokenRequest = {
    scope: 'email+offline_access+profile+openid',
    redirect_uri: 'https://www.bosch.com/boschcam',
    client_id: 'ciamids_047541CF-131C-4C7E-8F6B-659AA236A129',
    client_secret: 'iSNXQXQ2cxhb-dBkNaskSE-OerXGfC0OfhgsUjcl'
  };

  private isReadySubject = new BehaviorSubject(false);

  public constructor() {
    console.info('Start connection to Bosch');
    this.firstSetUpCredentials();
  }

  public waitUntilReady = async () => await firstValueFrom(this.isReadySubject.pipe(filter(x => x), first()));

  public async getAccessToken(): Promise<string> {
    if (this.tokens?.isValide()) {
      return this.tokens.access_token;
    } else if (this.tokens) {
      console.info('Access token no more valide');
      const newToken = await this.refreshTokens(this.tokens);
      return newToken.access_token;
    }
    throw 'No token are available';
  }

  private async firstSetUpCredentials() {
    try {
      const token = await fs.readFile(this.TOKEN_PATH);
      this.tokens = JSON.parse(token.toString()) as OAuth2Tokens;
      this.refreshTokens(this.tokens);
    } catch (err) {
      console.info('Read file error: ', err);
      await this.generateNewTokens();
    }
  }

  private async refreshTokens(tokens: OAuth2Tokens): Promise<OAuth2Tokens> {
    console.info('Start refresh token');
    const maxNumberOfTry = 3;
    for (let tryNumber = 1; tryNumber <= maxNumberOfTry; ++tryNumber) {
      const newTokens = await this.requestTokenToBosch(GrantType.RefreshToken, tokens.refresh_token);
      if (newTokens) {
        this.tokens = newTokens;
        console.info('Refresh token successful');
        this.isReadySubject.next(true);
        return this.tokens;
      } else {
        console.warn(`Failed refresh token request ${tryNumber}/${maxNumberOfTry}`);
      }
    }
    console.error(`All ${maxNumberOfTry} refresh token request to Bosch failed`);
    throw `All ${maxNumberOfTry} refresh token request to Bosch failed`;
  }

  private async generateNewTokens() {
    console.info('Generate a new tokens file');
    const maxNumberOfTry = 3;
    for (let tryNumber = 1; tryNumber <= maxNumberOfTry; ++tryNumber) {
      const info = this.generateOAuth2InfoForBosch();
      const newTokens = await this.getBoschOAuthToken(info);
      if (newTokens) {
        this.tokens = newTokens;
        this.isReadySubject.next(true);
        try {
          await fs.writeFile(this.TOKEN_PATH, JSON.stringify(this.tokens));
          console.log('Token stored to', this.TOKEN_PATH);
        } catch (err) {
          console.error('Failed to store token to', this.TOKEN_PATH);
          return console.error(err);
        }
        return;
      } else {
        console.warn(`Failed token request ${tryNumber}/${maxNumberOfTry}`);
      }
    }
    console.error(`All ${maxNumberOfTry} token request to Bosch failed`);
  }

  private getOAuth2Code(): IOAuth2Code {
    const codeVerifier = this.generateRandomCode();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);
    return {
      codeChallenge,
      codeVerifier
    };
  }

  private generateRandomCode(): string {
    return this.generateRandomString(128, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
  }

  private generateRandomString(size: number, authorizedCharacters: string): string {
    let randomString = "";
    for (let i = 0; i < size; i++) {
      randomString += authorizedCharacters[randomInt(authorizedCharacters.length - 1)];
    }
    return randomString;
  }

  private generateCodeChallenge(codeVerifier: string): string {
    const hasher = createHash('sha256');
    hasher.update(codeVerifier);
    const challenge = hasher.digest().toString('base64').replace('+', '-').replace('/', '_').replace('=', '');
    return challenge;
  }

  private getLoginPath = (codeChallenge: string, state: string) => "https://identity.bosch.com/connect/authorize?redirect_uri=https://www.bosch.com/boschcam&response_type=code&client_id=ciamids_047541CF-131C-4C7E-8F6B-659AA236A129&scope=email+offline_access+profile+openid&state=" + state + "&RedirectToIdentityProvider=AD%2BAUTHORITY&code_challenge_method=S256&code_challenge=" + codeChallenge;

  private generateOAuth2InfoForBosch(): IOAuth2ConnectionPageInfo {
    const oAuth2Code = this.getOAuth2Code();
    const randomState = this.generateRandomCode();
    const url = this.getLoginPath(oAuth2Code.codeChallenge, randomState);
    console.info(`This is the challange code: ${oAuth2Code.codeChallenge}`);
    console.info(`This is the code verifier: ${oAuth2Code.codeVerifier}`);
    console.info(`This is a random state: ${randomState}`);
    console.info(`Login address: ${url}`);
    return {
      requestCode: oAuth2Code,
      requestConnectionUrl: url
    };
  }

  private async getBoschOAuthToken(info: IOAuth2ConnectionPageInfo): Promise<OAuth2Tokens | undefined> {
    const credentials = await this.getBoschIdCredentials();
    const browser = await puppeteer.launch({args: ['--no-sandbox', '--disable-setuid-sandbox']});
    const page = await browser.newPage();
    console.info('Open Bosch connect page');
    await page.goto(info.requestConnectionUrl, {
      waitUntil: 'networkidle0',
    });
    if (!page.$('#email-field')) {
      console.info('Already log, waiting for redirection');
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
    } else {
      console.info('Enter login information');
      await page.type('#email-field', credentials.email);
      await page.type('#password-field', credentials.password);
      console.info('Waiting for redirection');
      await Promise.all([
        page.keyboard.press('Enter'),
        page.waitForNavigation({ waitUntil: 'networkidle0' })
      ]);
    }
    console.info('Connection done, retrieve of code in url');
    const code = await page.evaluate(() => {
      const params = new URLSearchParams(window.location.search);;
      return params.get('code');
    });
    await browser.close();
    if (!code) {
      return;
    }
    return await this.requestTokenToBosch(GrantType.NewToken, code, info.requestCode.codeVerifier);
  }

  private async getBoschIdCredentials(): Promise<IBoschIdCredentials> {
    try {
      const credentials = await fs.readFile(this.CREDENTIALS_PATH);
      return JSON.parse(credentials.toString());
    } catch (err) {
      console.error(`Please check if ${this.CREDENTIALS_PATH} file exists with BoschId email and password in it`);
      throw err;
    }
  }

  private async requestTokenToBosch(grantType: GrantType, codeOrRefreshToken: string, codeVerifier?: string): Promise<OAuth2Tokens | undefined> {
    try {
      const codePropertyName = grantType === GrantType.NewToken
        ? 'code'
        : 'refresh_token';
      const urlSearchParams = new url.URLSearchParams({
        ...this.baseBodyToRequestTokens,
        grant_type: grantType,
        [codePropertyName]: codeOrRefreshToken
      });
      if (codeVerifier) {
        urlSearchParams.append('code_verifier', codeVerifier);
      }
      const res = await axios
        .post(
          'https://identity.bosch.com/connect/token',
          urlSearchParams.toString(),
          {
            headers: { 'content-type': 'application/x-www-form-urlencoded' }
          }
        );
      return res.data as OAuth2Tokens;
    } catch (error: any) {
      console.error("Failed to get token from Bosch");
      console.error(error.response.status);
      console.error(error.response.data);
      return;
    }
  }
}
