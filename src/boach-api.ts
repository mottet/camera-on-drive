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
          resolve(true);
        })
      );
    } catch (error) {
      console.error(error);
      return false;
    }
  }

  public async deleteEvent(eventId: string): Promise<void> {
    const requestEventClipUrl = `${this.baseUrl}/events/${eventId}`;
    try {
      await this.createDeleteRequest(requestEventClipUrl);
    } catch (error) {
      console.error(error);
      throw error;
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

  private async createDeleteRequest<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      const token = await this.accessToken;
      const reponse = await axios.delete<T>(
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

export function getDateFromEventTimestamp(timestamp: string): Date;
export function getDateFromEventTimestamp(event: CameraEvent): Date;
export function getDateFromEventTimestamp(value: any): Date {
  const timestamp: string = value.timestamp || value;
  return new Date(timestamp.split('[')[0].replace(/ /g, ':'))
}

export function getTimestampFromEventTimestamp(timestamp: string): number;
export function getTimestampFromEventTimestamp(event: CameraEvent): number;
export function getTimestampFromEventTimestamp(value: any): number {
  return getDateFromEventTimestamp(value).getTime();
}

export function eventsByAscTimestamp(a: string, b: string): number
export function eventsByAscTimestamp(a: CameraEvent, b: CameraEvent): number
export function eventsByAscTimestamp(a: any, b: any): number {
  return getTimestampFromEventTimestamp(a) - getTimestampFromEventTimestamp(b);
}

export function eventsByDescTimestamp(a: string, b: string): number
export function eventsByDescTimestamp(a: CameraEvent, b: CameraEvent): number
export function eventsByDescTimestamp(a: any, b: any): number {
  return getTimestampFromEventTimestamp(b) - getTimestampFromEventTimestamp(a);
}
