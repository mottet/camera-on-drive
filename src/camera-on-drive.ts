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
      await this.downloadingLocallyClipFromBosch(event)
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
      await this.uploadingClipFromCameraToBosch(event);
        // .then(() => this.downloadingLocallyClipFromBosch(event))
        // .then(() => this.uploadingLocalClipToDrive(event, videosOnDrive))
        // .then(() => status[event.id] = 'Success')
        // .catch(() => status[event.id] = 'Fail');
    }
    return true;
  }

  private uploadingClipFromCameraToBosch(event: CameraEvent): Promise<boolean> {
    console.info(`Uploading clip ${event.timestamp} from camera to Bosch`);
    this.boschApi.requestClipEvents(event.id);
    const checkIfDownloadDone = (event: CameraEvent, resolve: (isDownloadDone: boolean) => void, reject: (reason: any) => void) => {
      setTimeout(async () => {
        const eventStatus = await this.boschApi.getEventStatus(event.id);
        switch (eventStatus) {
          case EventVideoClipUploadStatus.Done:
            console.info(`Upload ${event.timestamp} to Bosch succeeded`);
            resolve(true);
            break;
          case EventVideoClipUploadStatus.Pending:
            checkIfDownloadDone(event, resolve, reject);
            break;
          default:
            console.error(`Upload ${event.timestamp} to Bosch failed`);
            reject(`Upload ${event.timestamp} to Bosch failed`);
            break;
        }
      }, 5_000);
    }
    return new Promise((resolve, reject) => checkIfDownloadDone(event, resolve, reject))
  }

  private async downloadingLocallyClipFromBosch(event: CameraEvent): Promise<boolean> {
    console.info(`Downloading locally clip of ${event.timestamp}`);
    try {
      const isDownloadSuccess = await this.boschApi.downloadVideo(event.id, '.');
      if (!isDownloadSuccess) {
        console.info(`Local download of clip ${event.timestamp} failed`);
        return Promise.reject(`Local download of clip ${event.timestamp} failed`);
      } else {
        console.info(`Clip of ${event.timestamp} successfully downloaded locally`);
      }
    }
    catch (err) {
      console.error(err);
      return Promise.reject(err);
    }
    return true;
  }

  private async uploadingLocalClipToDrive(event: CameraEvent, videosOnDrive: Set<string>): Promise<boolean> {
    try {
      await this.ensureThatTheDriveHasEnoughSpace(event, videosOnDrive);
      console.info(`Uploading clip ${event.timestamp} on google drive`);
      await this.googleApi.uploadVideo(`${event.id}.mp4`, event.timestamp);
      console.info(`Deleting clip ${event.timestamp} locally stored`);
      this.deleteLocalFile(`${event.id}.mp4`);
    }
    catch (err) {
      console.error(err);
      return false;
    }
    return true;
  }

  private async ensureThatTheDriveHasEnoughSpace(event: CameraEvent, videosOnDrive: Set<string>) {
    while (!(await this.isEnoughSpaceInDriveForFile(`${event.id}.mp4`))) {
      console.info('There is not enough space on the drive. Need to delete the oldest video');
      let oldestVideo = this.getOldestVideoName(videosOnDrive);
      if (oldestVideo) {
        console.info(`Deleting ${oldestVideo} from drive`);
        const isVideoDeleted = await this.googleApi.deleteVideo(oldestVideo);
        if (isVideoDeleted) {
          videosOnDrive.delete(oldestVideo);
        }
      }
    }
  }

  private getOldestVideoName(videosOnDrive: Set<string>) {
    let oldestVideo: string | undefined;
    videosOnDrive.forEach(video => {
      if (!oldestVideo) {
        oldestVideo = video;
        return;
      }
      const oldestVideoDate = Date.parse(oldestVideo.split('[')[0].replace(/ /g, ':'));
      const videoDate = Date.parse(video.split('[')[0].replace(/ /g, ':'));
      if (oldestVideoDate > videoDate) {
        oldestVideo = video;
      }
    });
    return oldestVideo;
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
    const availableSpace = await this.googleApi.getAvailableSpace() - 10_000_000;
    if (availableSpace < stats.size) {
      const fileSize = this.humainReadableByteSize(stats.size);
      const availableSpaceSize = this.humainReadableByteSize(availableSpace);
      const missingSpaceSize = this.humainReadableByteSize(stats.size - availableSpace);
      console.info(`File size ${fileSize} but available space size ${availableSpaceSize}. Missing ${missingSpaceSize}.`);
      return false;
    }
    return true;
  }

  private humainReadableByteSize(bytes: number): string {
    if (bytes > 1_000_000_000) {
      return `${(Math.round(bytes / 10_000_000))/100}GB`;
    }
    if (bytes > 1_000_000) {
      return `${(Math.round(bytes / 10_000))/100}MB`;
    }
    if (bytes > 1_000) {
      return `${(Math.round(bytes / 10))/100}KB`;
    }
    return `${bytes}B`;
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
