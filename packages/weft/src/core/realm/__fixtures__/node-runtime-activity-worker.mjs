self.onmessage = ({ data }) => {
  self.postMessage({ operationId: data.operationId, status: 'completed', result: data.input });
};
