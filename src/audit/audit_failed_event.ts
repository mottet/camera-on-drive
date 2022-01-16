import { getDateFromEventTimestamp } from '../bosch/bosch-api';
import { GoogleDriveApi } from '../google/google-drive-api';
import fs from 'fs/promises';
import { constants } from 'fs';

console.info(JSON.stringify(process.argv));

(async () => {
  if (!(await doesFileExist(process.argv[2]))) {
    console.info('Please give the path of an existing file');
    return;
  }
  const eventsTimestamps = (await fs.readFile(process.argv[2]))
    .toString().split('\n');
  const dates =  eventsTimestamps.map(e => getDateFromEventTimestamp(e))
    .sort((a,b)=>a.getTime()-b.getTime());
  
  const googleApi = new GoogleDriveApi();
  await googleApi.waitUntilReady();
  const listName = await googleApi.listAllFilesName();
  const listDate = listName.map(n => getDateFromEventTimestamp(n));
  const setDate = new Set(listDate.map(d => d.toString()));
  const eventsWithFailedIndication = dates.map(e => setDate.has(e.toString())
    ? e.toString()
    : `${e} => FAILED`
  );

  await fs.writeFile('eventsWithFailedIndication', eventsWithFailedIndication.join('\n'));
})();

async function doesFileExist(filePath: string) {
  if (!filePath) {
    return false;
  }
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  }
  catch {
    return false;
  }
}

