/** Host DTO returned by the profile-selected content calendar endpoint. */
export interface CalendarEntry {
  show_id: number;
  event_id?: string;
  show_name: string;
  show_name_cn?: string;
  season_number: number;
  episode_number: number;
  episode_name: string;
  air_date: string;
  poster: string;
  backdrop?: string;
  overview?: string;
  vote_average: number;
  provider_id?: string;
  external_id?: string;
  douban_id?: string;
  douban_rating?: string;
}

export interface CalendarDay {
  date: string;
  entries: CalendarEntry[];
}

export interface CalendarResponse {
  start_date: string;
  end_date: string;
  days: CalendarDay[];
  total: number;
}
