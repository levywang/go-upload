import { UploadStatus } from '../types';

type ProgressCallback = (progress: number, speed: string) => void;
type StatusCallback = (status: UploadStatus, error?: string) => void;

export const simulateFileUpload = (
  file: File,
  path: string,
  onProgress: ProgressCallback,
  onStatusChange: StatusCallback
): () => void => {
  let progress = 0;
  let intervalId: number | null = null;
  
  // Simulate network latency start
  const startDelay = Math.random() * 500 + 200;

  setTimeout(() => {
    onStatusChange(UploadStatus.UPLOADING);
    
    // Random upload speed simulation
    const totalSize = file.size;
    let uploaded = 0;
    // Base speed: 500KB - 2MB per tick (approx 10-40MB/s simulated)
    const chunkSizeBase = 1024 * 512; 

    intervalId = window.setInterval(() => {
      // Randomize chunk size slightly
      const currentChunk = chunkSizeBase * (0.5 + Math.random());
      uploaded += currentChunk;

      if (uploaded >= totalSize) {
        uploaded = totalSize;
        progress = 100;
        onProgress(100, '0 MB/s');
        onStatusChange(UploadStatus.COMPLETED);
        if (intervalId) clearInterval(intervalId);
      } else {
        progress = (uploaded / totalSize) * 100;
        // Calculate artificial speed
        const speedMbps = ((currentChunk / 1024 / 1024) * 10).toFixed(1); // Mock speed
        onProgress(progress, `${speedMbps} MB/s`);
      }
    }, 100);

  }, startDelay);

  // Return cancel function
  return () => {
    if (intervalId) clearInterval(intervalId);
  };
};