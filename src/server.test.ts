import fs from 'fs';
import { loadData, hosts, tasks, automationConfigs, jobRunLogs, automationRunLogs, _resetInternalStateForTests, DATA_FILE_PATH, JOB_HISTORY_FILE_PATH } from './server';

jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

// We need to mock fs.promises specifically for async file operations
const mockFsPromises = {
  writeFile: jest.fn(),
  readFile: jest.fn(),
  readdir: jest.fn(),
  mkdir: jest.fn(),
};
// Since fs.promises is a getter, we mock it this way
Object.defineProperty(fs, 'promises', {
  get: () => mockFsPromises,
});


describe('loadData', () => {
  beforeEach(() => {
    // Reset state before each test
    _resetInternalStateForTests();
    // Reset mocks
    jest.clearAllMocks();
  });

  it('should initialize with default data and create files if none exist', async () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockFsPromises.writeFile.mockResolvedValue(undefined);

    await loadData();

    expect(hosts).toHaveLength(1);
    expect(hosts[0].id).toBe('localhost');
    expect(tasks).toEqual([]);
    expect(automationConfigs).toEqual([]);
    expect(jobRunLogs).toEqual([]);
    expect(automationRunLogs).toEqual([]);

    expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(2);
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(DATA_FILE_PATH, expect.stringContaining('"hosts":'), 'utf-8');
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(JOB_HISTORY_FILE_PATH, '[]', 'utf-8');
  });

  it('should load data from existing files', async () => {
    const mockMainData = {
      hosts: [{ id: 'host1', alias: 'Host 1', user: 'user', hostname: 'host1.com' }],
      tasks: [{ id: 'task1', name: 'Test Task' }],
      automationConfigs: [{ id: 'ac1', name: 'Test AC' }],
      jobRunLogs: [{ id: 'log1', taskId: 'task1' }],
    };
    const mockJobHistoryData = [{ id: 'ar1', automationConfigId: 'ac1' }];

    mockedFs.existsSync.mockImplementation((p) => {
      return p === DATA_FILE_PATH || p === JOB_HISTORY_FILE_PATH;
    });
    
    mockFsPromises.readFile.mockImplementation(async (p) => {
        if (p === DATA_FILE_PATH) {
            return JSON.stringify(mockMainData);
        }
        if (p === JOB_HISTORY_FILE_PATH) {
            return JSON.stringify(mockJobHistoryData);
        }
        throw new Error('File not found');
    });

    await loadData();

    expect(hosts).toHaveLength(2); // localhost + host1
    expect(hosts.find(h => h.id === 'host1')).toBeDefined();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('task1');
    expect(automationConfigs).toHaveLength(1);
    expect(automationConfigs[0].id).toBe('ac1');
    expect(jobRunLogs).toHaveLength(1);
    expect(jobRunLogs[0].id).toBe('log1');
    expect(automationRunLogs).toHaveLength(1);
    expect(automationRunLogs[0].id).toBe('ar1');

    expect(mockFsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('should handle empty or invalid JSON gracefully', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockRejectedValue(new Error('Invalid JSON'));
    mockFsPromises.writeFile.mockResolvedValue(undefined);

    await loadData();

    expect(hosts).toHaveLength(1);
    expect(hosts[0].id).toBe('localhost');
    expect(tasks).toEqual([]);
    expect(automationConfigs).toEqual([]);
    expect(jobRunLogs).toEqual([]);
    expect(automationRunLogs).toEqual([]);
    
    // It should write default files because parsing failed, leading to empty data structures
    expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(2);
  });

  it('should always include localhost, even if it is in the data file, without duplicates', async () => {
    const mockMainData = {
      hosts: [
        { id: 'localhost', alias: 'My Local', user: '', hostname: 'localhost' },
        { id: 'host1', alias: 'Host 1', user: 'user', hostname: 'host1.com' }
      ],
      tasks: [],
      automationConfigs: [],
      jobRunLogs: [],
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockFsPromises.readFile.mockImplementation(async (p) => {
        if (p === DATA_FILE_PATH) {
            return JSON.stringify(mockMainData);
        }
        if (p === JOB_HISTORY_FILE_PATH) {
            return JSON.stringify([]);
        }
        throw new Error('File not found');
    });

    await loadData();

    expect(hosts).toHaveLength(2);
    const localhostEntry = hosts.find(h => h.id === 'localhost');
    expect(localhostEntry).toBeDefined();
    expect(localhostEntry?.alias).toBe('My Local'); // It should preserve the alias
    expect(hosts.filter(h => h.id === 'localhost')).toHaveLength(1); // No duplicates
  });
});
