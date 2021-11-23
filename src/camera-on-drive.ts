import { statSync, unlinkSync } from 'fs';
import BoschApi, { EventVideoClipUploadStatus, eventsByDescTimestamp, EventType, CameraEvent, eventsByAscTimestamp } from './boach-api';
import { GoogleDriveApi } from './google-drive-api';

interface IEventPromiseStatus {
  [eventId: string]: 'Pending' | 'Success' | 'Fail';
}

export class CameraOnDrive {
  private googleApi = new GoogleDriveApi();
  private boschApi = new BoschApi();

  public async start() {
    await this.googleApi.waitUntilReady();
    console.info('Google drive API ready');
    await this.boschApi.waitUntilReady()
    console.info('Bosch API ready');
    console.info('Camera On Drive ready to go!');
    this.mainLoop();
  }

  private async mainLoop() {
    console.info(`<===============================>`);
    console.info('Fetching list of all videos\' name on the drive');
    const videosOnDrive = new Set(await this.googleApi.listAllFilesName());
    console.info('Fetching all the events of the camera');
    const eventsWithClipNotYetOnDrive = await this.getEventsWithClipNotYetOnDrive(videosOnDrive);
    if (eventsWithClipNotYetOnDrive.length) {
      this.copyMissingClipOnDrive(eventsWithClipNotYetOnDrive, videosOnDrive);
    } else {
      console.info('No more clip to get from camera');
      console.info('Waiting 60 secondes before checking again');
      setTimeout(() => this.mainLoop(), 60_000);
    }
  }

  private async getEventsWithClipNotYetOnDrive(videosOnDrive: Set<string>) {
    const events = await this.boschApi.getEvents();
    const eventsWithClipNotYetOnDrive = events
      .filter(e => e.eventType === EventType.MOVEMENT || e.eventType === EventType.AUDIO_ALARM)
      .filter(e => [
        EventVideoClipUploadStatus.Local,
        EventVideoClipUploadStatus.Pending,
        EventVideoClipUploadStatus.Done
      ].includes(e.videoClipUploadStatus))
      .filter(e => !videosOnDrive.has(`${e.timestamp}.mp4`))
      .sort(eventsByDescTimestamp);
    return eventsWithClipNotYetOnDrive;
  }

  private async copyMissingClipOnDrive(eventsWithClipNotYetOnDrive: CameraEvent[], videosOnDrive: Set<string>) {
    console.info(`There are ${eventsWithClipNotYetOnDrive.length} clip to download`);
    const uploadingToBosch: IEventPromiseStatus = {};
    const clipNeededToBeUploadToBoschEvents: CameraEvent[] = [];
    const clipReadyToBeUploadToDrive: CameraEvent[] = [];
    for (let event of eventsWithClipNotYetOnDrive) {
      if (event.videoClipUploadStatus === EventVideoClipUploadStatus.Local || event.videoClipUploadStatus === EventVideoClipUploadStatus.Pending) {
        uploadingToBosch[event.id] = 'Pending';
        clipNeededToBeUploadToBoschEvents.push(event);
      } else if (event.videoClipUploadStatus === EventVideoClipUploadStatus.Done) {
        clipReadyToBeUploadToDrive.push(event);
      }
    }
    const uploadingToDrive = this.uploadingAllReadyClipsFromBoschToDrive(clipReadyToBeUploadToDrive, videosOnDrive);
    this.uploadingAllClipsFromCameraToBosch(clipNeededToBeUploadToBoschEvents, videosOnDrive, uploadingToBosch);
    await this.waitingForPromiseToBeDone(uploadingToBosch, uploadingToDrive);
    setTimeout(() => this.mainLoop());
  }
  private async uploadingAllReadyClipsFromBoschToDrive(clipReadyToBeUploadToDrive: CameraEvent[], videosOnDrive: Set<string>) {
    let success = 0;
    let failure = 0;
    for (let event of clipReadyToBeUploadToDrive) {
      await this.downloadingLocallyClipFromBosch(event.id)
        .then(() => this.uploadingLocalClipToDrive(event, videosOnDrive))
        .then(() => ++success)
        .catch(() => ++failure);
    }
    return {
      success,
      failure
    };
  }

  private async uploadingAllClipsFromCameraToBosch(clipNeededToBeUploadToBoschEvents: CameraEvent[], videosOnDrive: Set<string>, status: IEventPromiseStatus): Promise<boolean> {
    const newestToOldestEvent = clipNeededToBeUploadToBoschEvents.sort(eventsByAscTimestamp);
    /**
     * Need to go one by one because the camera doesn't handle well too many request of download at the same time.
     * Starting with the newest to avoid looping in fail when the pool of clip is at its maximum (200):
     *  1) You try to get the older clip 
     *  2) The download of the older clip is slower than the arrival of a newer clip.
     *  3) The older video is delete before being download.
     *  4) Go to 1)
     */
    for (let event of newestToOldestEvent) {
      await this.uploadingClipFromCameraToBosch(event.id)
        .then(() => this.downloadingLocallyClipFromBosch(event.id))
        .then(() => this.uploadingLocalClipToDrive(event, videosOnDrive))
        .then(() => status[event.id] = 'Success')
        .catch(() => status[event.id] = 'Fail');
    }
    return true;
  }

  private uploadingClipFromCameraToBosch(id: string): Promise<boolean> {
    console.info(`Uploading clip ${id} from camera to Bosch`);
    this.boschApi.requestClipEvents(id);
    const checkIfDownloadDone = (id: string, resolve: (isDownloadDone: boolean) => void, reject: (reason: any) => void) => {
      setTimeout(async () => {
        const event = await this.boschApi.getEventStatus(id);
        switch (event) {
          case EventVideoClipUploadStatus.Done:
            console.info(`Upload ${id} to Bosch succeeded`);
            resolve(true);
            break;
          case EventVideoClipUploadStatus.Pending:
            checkIfDownloadDone(id, resolve, reject);
            break;
          default:
            console.error(`Upload ${id} to Bosch failed`);
            reject(`Upload ${id} to Bosch failed`);
            break;
        }
      }, 5_000);
    }
    return new Promise((resolve, reject) => checkIfDownloadDone(id, resolve, reject))
  }

  private async downloadingLocallyClipFromBosch(eventId: string): Promise<boolean> {
    console.info(`Downloading locally the clip ${eventId}`);
    try {
      const isDownloadSuccess = await this.boschApi.downloadVideo(eventId, '.');
      if (!isDownloadSuccess) {
        console.info(`Local download of clip ${eventId} failed`);
        return Promise.reject(`Local download of clip ${eventId} failed`);
      }
    }
    catch (err) {
      console.error(err);
      return Promise.reject(err);
    }
    return true;
  }

  private async uploadingLocalClipToDrive(event: CameraEvent, videosOnDrive: Set<string>): Promise<boolean> {
    console.info(`Downloading locally the clip ${event.id}`);
    try {
      while (!(await this.isEnoughSpaceInDriveForFile(`${event.id}.mp4`))) {
        console.info('There is not enough space on the drive. Need to delete the oldest video');
        let oldestVideo: string | undefined;
        videosOnDrive.forEach(video => {
          if (!oldestVideo || Date.parse(oldestVideo.split('[')[0]) > Date.parse(video.split('[')[0])) {
            oldestVideo = video;
          }
        });
        if (oldestVideo) {
          console.info(`Deleting ${oldestVideo} on drive`);
          this.googleApi.deleteVideo(oldestVideo);
        }
      }
      console.info(`Uploading clip ${event.id} on google drive`);
      await this.googleApi.uploadVideo(`${event.id}.mp4`, event.timestamp);
      console.info(`Deleting clip clip ${event.id} locally stored`);
      this.deleteLocalFile(`${event.id}.mp4`);
    }
    catch (err) {
      console.error(err);
      return false;
    }
    return true;
  }

  private async waitingForPromiseToBeDone(uploadingToBosch: IEventPromiseStatus, uploadingToDrive: Promise<{ success: number; failure: number; }>) {
    const uploadingToDriveResult = await uploadingToDrive;
    console.info(`Upload to drive of already upload to Bosch clips are done`);
    console.info(`Waiting for not upload to Bosch clips to be process`);
    const checkIfUploadToBoschDone = (resolve: () => void) => {
      setTimeout(async () => {
        const promiseByStatus = Object
          .values(uploadingToBosch)
          .reduce(
            (prev, current) => {
              prev[current]++;
              return prev;
            },
            { Pending: 0, Success: 0, Fail: 0 }
          );
        if (promiseByStatus.Pending == 0) {
          console.info(`All the pack is now done`);
          promiseByStatus.Success += uploadingToDriveResult.success;
          promiseByStatus.Fail += uploadingToDriveResult.failure;
          console.info(`In total ${promiseByStatus.Success} succeeded`);
          console.info(`In total ${promiseByStatus.Fail} failed`);
          resolve();
        } else {
          console.info(`Waiting for ${promiseByStatus.Pending} upload to be done`);
          console.info(`${promiseByStatus.Success} succeeded`);
          console.info(`${promiseByStatus.Fail} failed`);
          checkIfUploadToBoschDone(resolve);
        }
      }, 5_000);
    };
    return new Promise<void>(resolve => checkIfUploadToBoschDone(resolve));
  }

  private async isEnoughSpaceInDriveForFile(filePath: string): Promise<boolean> {
    const stats = statSync(filePath);
    const availableSpace = await this.googleApi.getAvailableSpace();
    console.log(`file size ${stats.size}`);
    console.log(`availableSpace ${availableSpace}`);
    return availableSpace >= stats.size;
  }

  private deleteLocalFile(filePath: string) {
    try {
      unlinkSync(filePath);
      console.info(`File ${filePath} is deleted.`);
    } catch (error) {
      console.error(`Deletion of file ${filePath} failed`, error);
    }
  }
}
