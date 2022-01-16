import BoschApi from './bosch/bosch-api';
import { BoschConnection } from './bosch/bosch-connection';
import { CameraOnDrive } from './camera-on-drive';
import { GoogleDriveApi } from './google/google-drive-api';

const googleApi = new GoogleDriveApi();
const boschConnection = new BoschConnection();
const boschApi = new BoschApi(boschConnection);

const cameraOnDrive = new CameraOnDrive(googleApi, boschApi);

cameraOnDrive.start();
