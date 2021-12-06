import { createReadStream } from 'fs';
import fs from 'fs/promises';
import readline from 'readline';
import { google } from 'googleapis';
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

export class GoogleDriveApi {
  // If modifying these scopes, delete google-token.json.
  private SCOPES = ['https://www.googleapis.com/auth/drive'];
  // The file token.json stores the user's access and refresh tokens, and is
  // created automatically when the authorization flow completes for the first
  // time.
  private TOKEN_PATH = 'google-token.json';

  private auth!: OAuth2Client;

  private isReadySubject = new BehaviorSubject(false);
  public waitUntilReady = async () => await firstValueFrom(this.isReadySubject.pipe(filter(x => x), first()));

  constructor() {
    this.requestGoogleDriveApi();
  }

  /**
   * Lists the names of all files.
   */
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
        nextPageToken = res.data.nextPageToken;
        atTheEndOfTheList = !nextPageToken;
      }
      return filesName;
    } catch (err) {
      console.error('The API returned an error: ' + err);
      throw err;
    }
  }

  /**
   * Get drive information
   */
  public async getDriveInfo() {
    const drive = google.drive({ version: 'v3', auth: this.auth });
    const about = await drive.about.get({
      fields: 'user,storageQuota'
    });
    return about.data;
  }

  /**
   * Get available space available in bytes
   */
  public async getAvailableSpace(): Promise<number> {
    const { storageQuota } = await this.getDriveInfo();
    const availableSpace = +(storageQuota?.limit || 0) - +(storageQuota?.usage || 0);
    return availableSpace;
  }

  /**
   * Upload video
   */
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

  /**
   * Delete video
   * Return true if deleted
   */
  public async deleteVideo(videoName: string): Promise<boolean> {
    const drive = google.drive({ version: 'v3', auth: this.auth });
    const res = await drive.files.list({
      fields: 'files(id)',
      q: `name='${videoName}'`
    });
    const video = res.data.files?.[0];
    try {
      await drive.files.delete({
        fileId: video?.id
      });
      console.info(`${videoName} deleted`);
      return true;
    } catch (err) {
      console.error(err);
    }
    return false;
  }

  //#region Credentials
  // Load client secrets from a local file.
  private async requestGoogleDriveApi() {
    try {
      const content = await fs.readFile('google-credentials.json');
      // Authorize a client with credentials, then call the Google Drive API.
      this.authorize(JSON.parse(content.toString()));
    } catch (err) {
      return console.log('Error loading client secret file:', err);
    }
  }
  /**
   * Create an OAuth2 client with the given credentials, and then execute the
   * given callback function.
   * @param {Object} credentials The authorization client credentials.
   */
  private async authorize(credentials: ICredentials) {
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    this.auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    // Check if we have previously stored a token.
    try {
      const token = await fs.readFile(this.TOKEN_PATH);
      this.auth.setCredentials(JSON.parse(token.toString()));
      this.isReadySubject.next(true);
    } catch (err) {
      return this.getAccessToken();
    }
  }

  /**
   * Get and store new token after prompting for user authorization.
   */
  private async getAccessToken() {
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
  //#endregion Credentials
}
