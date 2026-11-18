import { fitPeaks } from './xps.js';

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: fitPeaks(...data) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
