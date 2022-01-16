import { toDate } from './date-formatting';

test('It should convert Bosch event date string into JavaScript Date', ()=> {
  const dateString = '2021-12-08T17:52:47.339+01:00[Europe/Berlin]';
  const date: Date = toDate(dateString);
  expect(date).toEqual(new Date('2021-12-08T17:52:47.339+01:00'));
});
