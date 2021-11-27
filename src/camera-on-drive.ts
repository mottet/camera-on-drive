import { statSync, unlinkSync } from 'fs';
import BoschApi, { EventVideoClipUploadStatus, eventsByDescTimestamp, EventType, CameraEvent } from './boach-api';
import { GoogleDriveApi } from './google-drive-api';

export class CameraOnDrive {
  private googleApi = new GoogleDriveApi();
  private boschApi = new BoschApi();

  public async start() {
    await this.googleApi.waitUntilReady();
    console.info('Google drive API ready');
    await this.boschApi.waitUntilReady()
    console.info('Bosch API ready');
    console.info('Camera On Drive ready to go!');
    console.info('Fetching list of all videos\' name on the drive');
    const videosOnDrive = new Set(await this.googleApi.listAllFilesName());
    this.mainLoop(videosOnDrive);
  }

  private async mainLoop(videosOnDrive: Set<string>) {
    console.info(`<===============================>`);
    console.info('Fetching all the events of the camera');
    const eventsWithClipNotYetOnDrive = await this.getEventsWithClipNotYetOnDrive(videosOnDrive);
    if (eventsWithClipNotYetOnDrive.length) {
      await this.handleClipsNotYetOnDrive(eventsWithClipNotYetOnDrive, videosOnDrive);
    } else {
      console.info('No more clip to get from camera');
      console.info('Waiting 60 secondes before reloading drive\'s name list and checking again');
      setTimeout(async () => this.mainLoop(new Set(await this.googleApi.listAllFilesName())), 60_000);
    }
  }

  private async handleClipsNotYetOnDrive(eventsWithClipNotYetOnDrive: CameraEvent[], videosOnDrive: Set<string>) {
    const clipsReadyToBeUploadToDrive = eventsWithClipNotYetOnDrive.filter(e => e.videoClipUploadStatus === EventVideoClipUploadStatus.Done
    );
    const firstClipToUploadToBosch = eventsWithClipNotYetOnDrive.find(e => 
      e.videoClipUploadStatus === EventVideoClipUploadStatus.Local || 
      e.videoClipUploadStatus === EventVideoClipUploadStatus.Pending || 
      e.videoClipUploadStatus === EventVideoClipUploadStatus.Unavailable
    );
    if (clipsReadyToBeUploadToDrive.length) {
      await this.uploadingAllReadyClipsFromBoschToDrive(clipsReadyToBeUploadToDrive, videosOnDrive);
      setTimeout(() => this.mainLoop(videosOnDrive));
    } else if (firstClipToUploadToBosch && (
        firstClipToUploadToBosch.videoClipUploadStatus === EventVideoClipUploadStatus.Local ||
        firstClipToUploadToBosch.videoClipUploadStatus === EventVideoClipUploadStatus.Unavailable
      )) {
      this.uploadingClipFromCameraToBosch(firstClipToUploadToBosch);
      setTimeout(() => this.mainLoop(videosOnDrive), 10_000);
    } else {
      const numberOfClipsUploadindToBosch = eventsWithClipNotYetOnDrive.filter(e => 
        e.videoClipUploadStatus === EventVideoClipUploadStatus.Pending
      ).length;
      const numberOfClipsWaintingOnCamera = eventsWithClipNotYetOnDrive.filter(e => 
        e.videoClipUploadStatus === EventVideoClipUploadStatus.Local ||
        e.videoClipUploadStatus === EventVideoClipUploadStatus.Unavailable
      ).length;
      console.info(`${numberOfClipsUploadindToBosch} clips pending and ${numberOfClipsWaintingOnCamera} local`);
      console.info(`Waiting 10 secondes to check clip status.`);
      setTimeout(() => this.mainLoop(videosOnDrive), 10_000);
    }
  }

  private async getEventsWithClipNotYetOnDrive(videosOnDrive: Set<string>) {
    const events = await this.boschApi.getEvents();
    const eventsWithClipNotYetOnDrive = events
      .filter(e => e.eventType === EventType.MOVEMENT || e.eventType === EventType.AUDIO_ALARM)
      .filter(e => ![
        EventVideoClipUploadStatus.Permanently_unavailable,
        EventVideoClipUploadStatus.Unknown
      ].includes(e.videoClipUploadStatus))
      .filter(e => !videosOnDrive.has(`${e.timestamp}.mp4`))
      .sort(eventsByDescTimestamp);
    return eventsWithClipNotYetOnDrive;
  }

  private async uploadingAllReadyClipsFromBoschToDrive(clipReadyToBeUploadToDrive: CameraEvent[], videosOnDrive: Set<string>) {
    let success = 0;
    let failure = 0;
    let index = 0;
    for (let event of clipReadyToBeUploadToDrive) {
      index++;
      console.info(`==========${index.toString().padStart(3, '0')}/${clipReadyToBeUploadToDrive.length.toString().padStart(3, '0')}==========`);
      await this.downloadingLocallyClipFromBosch(event)
        .then(() => this.uploadingLocalClipToDrive(event, videosOnDrive))
        .then(() => {
          ++success;
          videosOnDrive.add(`${event.timestamp}.mp4`);
        })
        .catch(() => ++failure);
    }
    console.info(`===========================`);
    console.info(`Uploads done with ${success} success and ${failure} failures`);
  }

  private uploadingClipFromCameraToBosch(event: CameraEvent): Promise<boolean> {
    console.info(`Request upload of clip ${event.timestamp} from camera to Bosch`);
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
            resolve(false);
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
      return `${(bytes / 1_000_000_000).toFixed(2)}GB`;
    }
    if (bytes > 1_000_000) {
      return `${(bytes / 1_000_000).toFixed(2)}MB`;
    }
    if (bytes > 1_000) {
      return `${(bytes / 1_000).toFixed(2)}KB`;
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
