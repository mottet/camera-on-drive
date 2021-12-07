import { getDateFromEventTimestamp } from './bosch-api';
import { GoogleDriveApi } from './google-drive-api';

(async () => {
  const googleApi = new GoogleDriveApi();
  await googleApi.waitUntilReady();
  const listName = await googleApi.listAllFilesName();
  const listDate = listName.map(n => getDateFromEventTimestamp(n));
  listDate.sort((a,b)=>a.getTime()-b.getTime());
  const countByDate: { [date:string]: number } = {};
  const countByHour: { [date:string]: number } = {};
  listDate.forEach(d => {
    const date = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const hour = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}H`;
    if (countByDate[date]) {
      countByDate[date]++;
    } else {
      countByDate[date] = 1;
    }
    if (countByHour[hour]) {
      countByHour[hour]++;
    } else {
      countByHour[hour] = 1;
    }
  });
  console.info(countByDate);
  console.info(countByHour);
})();
