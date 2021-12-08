import { statSync, unlinkSync } from 'fs';
import fs from 'fs/promises';
import { IBoschApi, EventVideoClipUploadStatus, eventsByAscTimestamp, EventType, CameraEvent, getDateFromEventTimestamp } from './bosch-api';
import { IGoogleDriveApi } from './google-drive-api';

export class CameraOnDrive {

  constructor(
    private readonly googleApi: IGoogleDriveApi,
    private readonly boschApi: IBoschApi
  ) { }

  private readonly maxNumberOfFavoriteEvent = 25;
  private readonly maxNumberOfNotFavoriteEvent = 200;
  private readonly maxNumberOfManualRequest = 3;

  public async start() {
    await this.googleApi.waitUntilReady();
    console.info('Google drive API ready');
    await this.boschApi.waitUntilReady();
    console.info('Bosch API ready');
    console.info('Camera On Drive ready to go!');
    console.info('Fetching list of all videos\' name on the drive');
    const videosOnDrive = new Set(await this.googleApi.listAllFilesName());
    console.info('Start the main loop');
    this.mainLoop(videosOnDrive);
  }

  private async mainLoop(videosOnDrive: Set<string>) {
    await this.recordInFileAllEventsEncounted();
    const eventsWithClipNotYetOnDrive = await this.getEventsWithClipNotYetOnDrive(videosOnDrive);
    if (eventsWithClipNotYetOnDrive.length) {
      await this.handleClipsNotYetOnDrive(eventsWithClipNotYetOnDrive, videosOnDrive);
    } else {
      setTimeout(async () => this.mainLoop(new Set(await this.googleApi.listAllFilesName())), 30_000);
    }
  }

  private async handleClipsNotYetOnDrive(eventsWithClipNotYetOnDrive: CameraEvent[], videosOnDrive: Set<string>) {
    console.info('<===============================>');
    console.info('Clip to handle detected');
    const { clipsReadyToBeUploadToDrive, clipsToBeRequest, clipsPending } = this.splitCameraEventByClipStatus(eventsWithClipNotYetOnDrive);
    if (this.canClipsBeUpload(clipsReadyToBeUploadToDrive)) {
      await this.uploadingAllReadyClipsFromBoschToDrive(clipsReadyToBeUploadToDrive, videosOnDrive);
      setTimeout(() => this.mainLoop(videosOnDrive));
    } else if (this.canClipsBeRequest(clipsToBeRequest, clipsPending)) {
      const lastClipToUploadToBosch = clipsToBeRequest[clipsToBeRequest.length - 1];
      this.uploadingClipFromCameraToBosch(lastClipToUploadToBosch);
      setTimeout(() => this.mainLoop(videosOnDrive), 10_000);
    } else if (this.shouldClipBeSetAsFavorite(eventsWithClipNotYetOnDrive)) {
      this.setOldestNonFavoriteEventAsFavorite(eventsWithClipNotYetOnDrive);
      setTimeout(() => this.mainLoop(videosOnDrive));
    } else {
      console.info(`${clipsPending.length} clips pending and ${clipsToBeRequest.length} local`);
      setTimeout(() => this.mainLoop(videosOnDrive), 10_000);
    }
  }

  private readonly canClipsBeUpload = (clipsReadyToBeUploadToDrive: CameraEvent[]) => clipsReadyToBeUploadToDrive.length > 0;
  private readonly canClipsBeRequest = (clipsToBeRequest: CameraEvent[], clipsPending: CameraEvent[]) => clipsToBeRequest.length > 0 && clipsPending.length < this.maxNumberOfManualRequest;
  private shouldClipBeSetAsFavorite(eventsWithClipNotYetOnDrive: CameraEvent[]): boolean {
    const numberOfFavoriteEvent = eventsWithClipNotYetOnDrive.filter(e => e.isFavorite).length;
    const numberOfNotFavoriteEvent = eventsWithClipNotYetOnDrive.filter(e => !e.isFavorite).length;
    return numberOfFavoriteEvent < this.maxNumberOfFavoriteEvent && numberOfNotFavoriteEvent >= this.maxNumberOfNotFavoriteEvent;
  }

  private splitCameraEventByClipStatus(eventsWithClipNotYetOnDrive: CameraEvent[]) {
    const clipsReadyToBeUploadToDrive: CameraEvent[] = [];
    const clipsToBeRequest: CameraEvent[] = [];
    const clipsPending: CameraEvent[] = [];
    eventsWithClipNotYetOnDrive.forEach(e => {
      switch (e.videoClipUploadStatus) {
        case EventVideoClipUploadStatus.Done:
          clipsReadyToBeUploadToDrive.push(e);
          break;
        case EventVideoClipUploadStatus.Local:
        case EventVideoClipUploadStatus.Unavailable:
          clipsToBeRequest.push(e);
          break;
        case EventVideoClipUploadStatus.Pending:
          clipsPending.push(e);
          break;
        default:
          break;
      }
    });
    return { clipsReadyToBeUploadToDrive, clipsToBeRequest, clipsPending };
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
      .sort(eventsByAscTimestamp);
    return eventsWithClipNotYetOnDrive;
  }

  private async uploadingAllReadyClipsFromBoschToDrive(clipReadyToBeUploadToDrive: CameraEvent[], videosOnDrive: Set<string>) {
    let success = 0;
    let failure = 0;
    let index = 0;
    for (const event of clipReadyToBeUploadToDrive) {
      index++;
      console.info(`==========${index.toString().padStart(3, '0')}/${clipReadyToBeUploadToDrive.length.toString().padStart(3, '0')}==========`);
      await this.downloadingLocallyClipFromBosch(event)
        .then(async () => await this.uploadingLocalClipToDrive(event, videosOnDrive))
        .then(async () => {
          ++success;
          videosOnDrive.add(`${event.timestamp}.mp4`);
          await this.boschApi.deleteEvent(event.id);
          console.info(`Event of clip ${event.timestamp} delete on Bosch cloud`);
        })
        .catch(() => ++failure);
    }
    console.info('===========================');
    console.info(`Uploads done with ${success} success and ${failure} failures`);
  }

  private uploadingClipFromCameraToBosch(event: CameraEvent): Promise<boolean> {
    console.info(`Request upload of clip ${event.timestamp} from camera to Bosch`);
    this.boschApi.requestClipEvents(event.id);
    const checkIfDownloadDone = (event: CameraEvent, resolve: (isDownloadDone: boolean) => void) => {
      setTimeout(async () => {
        const eventStatus = await this.boschApi.getEventStatus(event.id);
        switch (eventStatus) {
          case EventVideoClipUploadStatus.Done:
            console.info(`Upload ${event.timestamp} to Bosch succeeded`);
            resolve(true);
            break;
          case EventVideoClipUploadStatus.Pending:
            checkIfDownloadDone(event, resolve);
            break;
          default:
            console.error(`Upload ${event.timestamp} to Bosch failed`);
            resolve(false);
            break;
        }
      }, 5_000);
    };
    return new Promise((resolve) => checkIfDownloadDone(event, resolve));
  }

  private setOldestNonFavoriteEventAsFavorite(eventsWithClipNotYetOnDrive: CameraEvent[]) {
    const eventToSetAsFavorite = eventsWithClipNotYetOnDrive.find(e => !e.isFavorite);
    if (eventToSetAsFavorite) {
      console.info(`Setting ${eventToSetAsFavorite.id} from ${eventToSetAsFavorite.timestamp} as favorite to try to keep it longer`);
      this.boschApi.setEventFavoriteStatus(eventToSetAsFavorite?.id, true);
    } else {
      console.info('Cannot find an event that is not yet a favorite');
    }
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
      const oldestVideo = this.getOldestVideoName(videosOnDrive);
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
      const oldestVideoDate = getDateFromEventTimestamp(oldestVideo);
      const videoDate = getDateFromEventTimestamp(video);
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

  private readonly aGigaByte = 1_000_000_000;
  private readonly aMegaByte = 1_000_000;
  private readonly aKiloByte = 1_000;
  private humainReadableByteSize(bytes: number): string {
    if (bytes > this.aGigaByte) {
      return `${(bytes / this.aGigaByte).toFixed(2)}GB`;
    }
    if (bytes > this.aMegaByte) {
      return `${(bytes / this.aMegaByte).toFixed(2)}MB`;
    }
    if (bytes > this.aKiloByte) {
      return `${(bytes / this.aKiloByte).toFixed(2)}KB`;
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

  private readonly bootTimestamp = new Date().toISOString();
  private readonly allEventsEncounted = new Set<string>();
  private async recordInFileAllEventsEncounted() {
    const currentEvents = await this.boschApi.getEvents();
    currentEvents.forEach(event => {
      this.allEventsEncounted.add(event.timestamp);
    });
    const eventsFromOlderToYounger = [...this.allEventsEncounted].sort(eventsByAscTimestamp);
    try {
      await fs.writeFile(this.bootTimestamp, eventsFromOlderToYounger.join('\n'));
    } catch (err) {
      console.error('Failed to store encounted events in file ', this.bootTimestamp);
      console.error(err);
    }
  }
}
