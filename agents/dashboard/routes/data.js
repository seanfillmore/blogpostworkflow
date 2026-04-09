// agents/dashboard/routes/data.js
import { respondJson } from '../lib/responses.js';

export default [
  {
    method: 'GET',
    match: '/api/data',
    handler(req, res, ctx) {
      respondJson(res, ctx.loadData());
    },
  },
];
