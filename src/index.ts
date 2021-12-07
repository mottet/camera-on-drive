import BoschApi from './bosch-api';
import { CameraOnDrive } from './camera-on-drive';
import { GoogleDriveApi } from './google-drive-api';

const googleApi = new GoogleDriveApi();
const boschApi = new BoschApi();

const cameraOnDrive = new CameraOnDrive(googleApi, boschApi);

cameraOnDrive.start();
