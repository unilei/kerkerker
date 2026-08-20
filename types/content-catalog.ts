/** Host-declared catalog view; it never names a concrete provider endpoint. */
export type CatalogView =
  | "category"
  | "featured"
  | "new-releases"
  | "sections"
  | "latest";

export type CatalogSort = "recommended" | "release-date" | "rating";

export interface CatalogFilters {
  contentType?: "movie" | "series";
  genre?: string;
  year?: string;
  region?: string;
  sort?: CatalogSort;
}

/** Provider-neutral item returned by the profile-selected catalog endpoint. */
export interface CatalogItem {
  id: string;
  title: string;
  rating: string;
  posterUrl: string;
  backdropUrl?: string;
  canonicalUrl: string;
  episodeInfo?: string;
  description?: string;
  genres?: string[];
}

export interface CatalogSection {
  key: string;
  title: string;
  items: CatalogItem[];
}

/** Compatibility DTO used by category pages during the UI migration. */
export interface CatalogSubject {
  id: string;
  title: string;
  rate: string;
  cover: string;
  url: string;
  episode_info?: string;
}

export interface CatalogPagination {
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface CatalogResponse {
  view: CatalogView;
  key?: string;
  filters?: CatalogFilters;
  items: CatalogItem[];
  sections: CatalogSection[];
  /** @deprecated Prefer items; retained for existing category-page consumers. */
  subjects: CatalogSubject[];
  pagination: CatalogPagination;
}
