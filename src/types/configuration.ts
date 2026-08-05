export type RunConfiguration = {
  dbName: string;
  extensions: string[];
  directories: string[];
  ignore_directories?: string[];
  update_records?: boolean;
  process_directories?: boolean;
  resync_directories?: boolean;
  resync_check_actual_file?: boolean;
};
