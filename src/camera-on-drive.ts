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
    for (let event of [eventsWithClipNotYetOnDrive[0]]) {
      console.info(`==========`);
      console.info(`Dealing with event id ${event.id}`);
      if (event.videoClipUploadStatus === EventVideoClipUploadStatus.Local || event.videoClipUploadStatus === EventVideoClipUploadStatus.Pending) {
        await this.uploadingClipFromCameraToBosch(event.id);
      }
      console.info('Downloading locally the clip');
      await this.boschApi.downloadVideo(event.id, '.');
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
      console.info('Uploading video on google drive');
      await this.googleApi.uploadVideo(`${event.id}.mp4`, event.timestamp);
      console.info('Deleting the clip locally stored');
      this.deleteLocalFile(`${event.id}.mp4`);
    }
    console.info(`[Done with all clips]`);
    setTimeout(() => this.mainLoop());
  }

  private uploadingClipFromCameraToBosch(id: string): Promise<void> {
    console.info('Uploading clip from camera to Bosch');
    this.boschApi.requestClipEvents(id);
    const checkIfDownloadDone = (id: string, resolve: () => void) => {
      setTimeout(async () => {
        const isDone = await this.boschApi.isEventDoneDownloading(id);
        if (isDone) {
          resolve();
        } else {
          checkIfDownloadDone(id, resolve);
        }
      }, 10_000);
    }
    return new Promise(resolve => checkIfDownloadDone(id, resolve))
  }

  private async isEnoughSpaceInDriveForFile(filePath: string): Promise<boolean> {
    const stats = statSync(filePath);
    const availableSpace = await this.googleApi.getAvailableSpace();
    console.log(`file size ${availableSpace}`);
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
