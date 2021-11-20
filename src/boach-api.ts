import axios, { AxiosRequestConfig } from 'axios';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { BoachConnection } from './boach-connection';

export enum EventType {
  TROUBLE_CONNECT = 'TROUBLE_CONNECT',
  MOVEMENT = 'MOVEMENT',
  TROUBLE_DISCONNECT = 'TROUBLE_DISCONNECT',
  TROUBLE_RECORDING_OFF = 'TROUBLE_RECORDING_OFF',
  TROUBLE_RECORDING_ON = 'TROUBLE_RECORDING_ON',
  AUDIO_ALARM = 'AUDIO_ALARM'
}

export enum EventVideoClipUploadStatus {
  Unknown = 'Unknown',
  Local = 'Local',
  Pending = 'Pending',
  Done = 'Done',
  Unavailable = 'Unavailable',
  Permanently_unavailable = 'Permanently_unavailable',
}

export interface CameraEvent {
  id: string,
  videoInputId: string, // Camera Id
  eventType: EventType,
  title: string,
  timestamp: string,
  isFavorite: boolean,
  isRead: boolean,
  imageUrl: string
  videoClipUrl: string,
  videoClipUploadStatus: EventVideoClipUploadStatus,
  videoClipUploadProgress?: number // null or 0 or 100
}

export default class BoachApi {

  private boschConnection: BoachConnection;
  public get accessToken(): Promise<string> {
    return this.boschConnection.getAccessToken();
  }

  private baseUrl = 'https://residential.cbs.boschsecurity.com/v7';

  public constructor() {
    this.boschConnection = new BoachConnection();
  }

  public waitUntilReady = async () => await this.boschConnection.waitUntilReady();

  public async displayEvents() {
    const eventUrl = `${this.baseUrl}/events`;
    try {
      const localVideoEvents = await (await this.createGetRequest<CameraEvent[]>(eventUrl)).filter(e => e.videoClipUploadStatus === EventVideoClipUploadStatus.Local);
      console.log('Successfully downloaded events!');
      console.log(`There are ${localVideoEvents.length} events.`);
      console.log(localVideoEvents)
    } catch (error) {
      console.error(error);
    }
  }

  public async getEvent(eventId: string): Promise<CameraEvent | undefined> {
    return (await this.getEvents()).find(e => e.id === eventId);
  }

  public async getEvents(): Promise<CameraEvent[]> {
    try {
      const eventsUrl = `${this.baseUrl}/events`;
      return await this.createGetRequest<CameraEvent[]>(eventsUrl);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  public async requestClipEvents(eventId: string): Promise<void> {
    const requestEventClipUrl = `${this.baseUrl}/events/${eventId}/request_clip`;
    try {
      await this.createGetRequest(requestEventClipUrl);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  public async getEventStatus(eventId: string): Promise<EventVideoClipUploadStatus | undefined> {
    const requestEvent = await this.getEvent(eventId);
    return requestEvent?.videoClipUploadStatus;
  }

  public async downloadVideo(videoId: string, downloadFolder: string): Promise<boolean> {
    const videoUrl = `${this.baseUrl}/events/${videoId}/clip.mp4`;
    const localFilePath = path.resolve(downloadFolder, `${videoId}.mp4`);
    try {
      const videoSteam = await this.createGetRequest<any>(videoUrl, { responseType: 'stream' });
      const w = videoSteam.pipe(fs.createWriteStream(localFilePath));
      return new Promise(resolve => 
        w.on('finish', () => {
          console.log('Successfully downloaded file!');
          resolve(true);
        })
      );
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  private async createGetRequest<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      const token = await this.accessToken;
      const reponse = await axios.get<T>(
        url,
        {
          headers: {
            Authorization: `Bearer ${token}`
          },
          httpsAgent: new https.Agent({
            rejectUnauthorized: false
          }),
          ...config
        }
      );
      return reponse.data;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }
}

export function eventsByAscTimestamp(a: CameraEvent, b: CameraEvent): number {
  return Date.parse(b.timestamp.split('[')[0]) - Date.parse(a.timestamp.split('[')[0]);
}

export function eventsByDescTimestamp(a: CameraEvent, b: CameraEvent): number {
  return Date.parse(a.timestamp.split('[')[0]) - Date.parse(b.timestamp.split('[')[0]);
}
