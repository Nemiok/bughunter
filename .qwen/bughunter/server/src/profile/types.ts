export type ExtractorKind = 'table' | 'chart' | 'scene' | 'dom';

export type ProfileExtractor = {
  name: string;
  widget: string;
  kind: ExtractorKind;
  script: string;
};

export type OracleBinding = {
  urlPattern: string;
  widget: string;
  fields: string[];
};

export type FieldContract = {
  path: string;
  format?: 'number' | 'string' | 'date';
  unit?: string;
  rounding?: number;
  timezone?: string;
  aggregation?: 'sum' | 'avg' | 'count' | 'none';
};

export type ResetRecipe = {
  kind: 'storage-flag' | 'mock-endpoint';
  key?: string;
  url?: string;
};

export type Profile = {
  name: string;
  extractors: ProfileExtractor[];
  oracles: OracleBinding[];
  contract?: FieldContract[];
  reset?: ResetRecipe;
  navigation?: { idSegmentPattern: string };
  testData?: { dir: string };
  /** Откуда брать эталон ответов: из перехвата браузера или из страничного хука приложения. */
  responseSource?: 'playwright' | 'page-hook';
  browser?: { launchArgs?: string[] };
};
