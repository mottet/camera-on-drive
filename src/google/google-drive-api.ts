import { createReadStream } from 'fs';
import fs from 'fs/promises';
import readline from 'readline';
import { drive_v3, google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { BehaviorSubject, filter, first, firstValueFrom } from 'rxjs';

interface ICredentials {
  installed: {
    client_id: string;
    project_id: string;
    auth_uri: string;
    token_uri: string;
    auth_provider_x509_cert_url: string;
    client_secret: string;
    redirect_uris: string[];
  }
}

export interface IGoogleDriveApi {
  waitUntilReady: () => Promise<boolean>;
  listAllFilesName(): Promise<string[]>;
  getDriveInfo(): Promise<drive_v3.Schema$About>;
  getAvailableSpaceInBytes(): Promise<number>;
  uploadVideo(pathToVideo: string, videoName: string): Promise<boolean>;
  deleteFile(videoName: string): Promise<boolean>;
}

export class GoogleDriveApi implements IGoogleDriveApi {
  // If modifying these scopes, delete google-token.json.
  private SCOPES = ['https://www.googleapis.com/auth/drive'];
  // The file google-token.json stores the user's access and refresh tokens, and is
  // created automatically when the authorization flow completes for the first
  // time.
  private TOKEN_PATH = 'google-token.json';

  private auth!: OAuth2Client;

  private isReadySubject = new BehaviorSubject(false);
  public waitUntilReady = async () => await firstValueFrom(this.isReadySubject.pipe(filter(x => x), first()));

  constructor() {
    this.loadClientSecretsFromLocalFile();
  }

  public async listAllFilesName(): Promise<string[]> {
    const drive = google.drive({ version: 'v3', auth: this.auth });
    try {
      let atTheEndOfTheList = false;
      let nextPageToken: string | undefined;
      const filesName: string[] = [];
      while (!atTheEndOfTheList) {
        const res = await drive.files.list({
          fields: 'files(name),nextPageToken',
          pageSize: 1000,
          pageToken: nextPageToken
        });
        res.data.files?.filter(file => file.name).forEach(file => filesName.push(file.name as string));
        nextPageToken = res.data.nextPageToken || undefined;
        atTheEndOfTheList = !nextPageToken;
      }
      return filesName;
    } catch (err) {
      console.error('The API returned an error: ' + err);
      throw err;
    }
  }

  public async getDriveInfo(): Promise<drive_v3.Schema$About> {
    const drive = google.drive({ version: 'v3', auth: this.auth });
    const about = await drive.about.get({
      fields: 'user,storageQuota'
    });
    return about.data;
  }

  public async getAvailableSpaceInBytes(): Promise<number> {
    const { storageQuota } = await this.getDriveInfo();
    const availableSpace = +(storageQuota?.limit || 0) - +(storageQuota?.usage || 0);
    return availableSpace;
  }

  public async uploadVideo(pathToVideo: string, videoName: string): Promise<boolean> {
    const fileMetadata = {
      name: `${videoName}.mp4`
    };
    const media = {
      mimeType: 'video/mp4',
      body: createReadStream(pathToVideo)
    };
    const drive = google.drive({ version: 'v3', auth: this.auth });
    try {
      await drive.files.create({
        requestBody: fileMetadata,
        media
      });
      console.info(`Upload of video ${videoName} successful`);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  }

  public async deleteFile(fileName: string): Promise<boolean> {
    const drive = google.drive({ version: 'v3', auth: this.auth });
    const res = await drive.files.list({
      fields: 'files(id)',
      q: `name='${fileName}'`
    });
    const file = res.data.files?.[0];
    try {
      await drive.files.delete({
        fileId: file?.id || undefined
      });
      console.info(`${fileName} deleted`);
      return true;
    } catch (err) {
      console.error(err);
    }
    return false;
  }

  private async loadClientSecretsFromLocalFile() {
    try {
      const content = await fs.readFile('google-credentials.json');
      this.initializeAuthorizationObject(JSON.parse(content.toString()));
    } catch (err) {
      return console.log('Error loading client secret file:', err);
    }
  }

  private async initializeAuthorizationObject(credentials: ICredentials) {
    this.createAuthorizationObject(credentials);
    try {
      await this.setAccessTokenIfAvailaibleInLocalFile();
    } catch (err) {
      return this.generateNewAccessToken();
    }
  }

  private async setAccessTokenIfAvailaibleInLocalFile() {
    const token = await fs.readFile(this.TOKEN_PATH);
    this.auth.setCredentials(JSON.parse(token.toString()));
    this.isReadySubject.next(true);
  }

  private createAuthorizationObject(credentials: ICredentials) {
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    this.auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  }

  private async generateNewAccessToken() {
    const authUrl = this.auth.generateAuthUrl({
      access_type: 'offline',
      scope: this.SCOPES,
    });
    console.log('Authorize this app by visiting this url:', authUrl);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Enter the code from that page here: ', async (code: string) => {
      rl.close();
      try {
        const token = await this.auth.getToken(code);
        this.auth.setCredentials(token.tokens);
        this.isReadySubject.next(true);
        // Store the token to disk for later program executions
        try {
          await fs.writeFile(this.TOKEN_PATH, JSON.stringify(token.tokens));
          console.log('Token stored to', this.TOKEN_PATH);
        } catch (err) {
          return console.error('Failed storing token ', this.TOKEN_PATH, err);
        }
      } catch (err) {
        return console.error('Error retrieving access token', err);
      }
    });
  }
}
