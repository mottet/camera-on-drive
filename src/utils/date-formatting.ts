import parseISO from 'date-fns/fp/parseISO';
import addHours from 'date-fns/fp/addHours';

export function toDate(date: string): Date {
  return addHours(-1)(parseISO(date));
}
