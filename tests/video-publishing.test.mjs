import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_BYTES,
  validateVideoFile,
  classifyVideoContainerStatus,
  buildVideoContainerParams,
  beginVideoPost,
  processVideoPosts
} from '../src/video-publishing.mjs';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function database(initial) {
  const post = {
    id: 'p1',
    text: '貓掌江湖 15 秒預告',
    media_type: 'VIDEO',
    media_url: 'https://threads-scheduler.example/media/uploads/test.mp4',
    status: 'scheduled',
    video_container_id: null,
    video_started_at: null,
    video_next_check_at: null,
    video_publish_requested_at: null,
    attempts: 0,
    ...initial
  };
  const db = {
    post,
    prepare(sql) {
      const op = { args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (sql.includes('FROM settings')) return { value: 'token-test' };
          return null;
        },
        async all() {
          if (sql.includes("status='processing'") && post.status === 'processing' &&
              (!post.video_next_check_at || post.video_next_check_at <= new Date().toISOString())) {
            return { results: [{ ...post }] };
          }
          return { results: [] };
        },
        async run() {
          const a = this.args;
          const prev = post.status;
          if (sql.includes("SET status='preparing'")) {
            if (!['scheduled', 'failed'].includes(prev)) return { meta: { changes: 0 } };
            post.status = 'preparing'; post.error = null;
          } else if (sql.includes("SET status='processing'")) {
            post.status = 'processing'; post.video_container_id = a[0];
            post.video_started_at = a[1]; post.video_next_check_at = a[2];
          } else if (sql.includes("SET status='failed'")) {
            post.status = 'failed'; post.error = a[0]; post.attempts++;
          } else if (sql.includes("SET video_next_check_at=")) {
            post.video_next_check_at = a[0]; post.error = a[1];
          } else if (sql.includes("SET status='publishing'")) {
            if (prev !== 'processing') return { meta: { changes: 0 } };
            post.status = 'publishing'; post.video_publish_requested_at = a[0];
          } else if (sql.includes("SET status='published'")) {
            post.status = 'published'; post.thread_id = a[0];
            post.permalink = a[1]; post.published_at = a[2];
            post.attempts++;
          } else if (sql.includes("SET status='publish_unknown'")) {
            post.status = 'publish_unknown'; post.error = a[0];
          } else {
            throw new Error('Unexpected SQL: ' + sql);
          }
          return { meta: { changes: 1 } };
        }
      };
      return op;
    }
  };
  return { DB: db, post };
}

test('validates MP4 size and MIME before upload', () => {
  assert.equal(validateVideoFile({ size: 1000, type: 'video/mp4' }), true);
  assert.throws(() => validateVideoFile({ size: MAX_VIDEO_BYTES + 1, type: 'video/mp4' }), /25 MB/);
  assert.throws(() => validateVideoFile({ size: 100, type: 'video/quicktime' }), /video\/mp4/);
  assert.throws(() => validateVideoFile({ size: 0, type: 'video/mp4' }), /MP4/);
});

test('enforces HTTPS URL, full caption and explicit VIDEO media type', () => {
  const { post } = database();
  const params = buildVideoContainerParams('token', post);
  assert.equal(params.get('media_type'), 'VIDEO');
  assert.equal(params.get('video_url'), post.media_url);
  assert.equal(params.get('text'), post.text);
  assert.throws(() => buildVideoContainerParams('token', { ...post, media_url: 'http://unsafe.test/v.mp4' }), /HTTPS/);
  assert.throws(() => buildVideoContainerParams('token', { ...post, text: 'a'.repeat(501) }), /500/);
  assert.throws(() => buildVideoContainerParams('token', { ...post, media_type: 'TEXT' }), /VIDEO/);
});

test('recognizes Meta video processing statuses', () => {
  assert.equal(classifyVideoContainerStatus('in_progress'), 'waiting');
  assert.equal(classifyVideoContainerStatus('FINISHED'), 'ready');
  assert.equal(classifyVideoContainerStatus('ERROR'), 'failed');
  assert.equal(classifyVideoContainerStatus('EXPIRED'), 'failed');
  assert.equal(classifyVideoContainerStatus('PUBLISHED'), 'already_published');
  assert.equal(classifyVideoContainerStatus('WAITING_FOR_UPLOAD'), 'unknown');
});

test('creates exactly one remote media container and stores processing state', async () => {
  const env = database();
  let creates = 0;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/me\/threads\?/);
    assert.equal(options.method, 'POST');
    creates++;
    return response({ id: 'container-001' });
  };
  const out = await beginVideoPost(env, { ...env.post });
  assert.equal(out.status, 'processing');
  assert.equal(env.post.video_container_id, 'container-001');
  assert.equal(env.post.status, 'processing');
  assert.equal(creates, 1);
  await assert.rejects(() => beginVideoPost(env, { ...env.post }), /不允許重複發布/);
  assert.equal(creates, 1);
});

test('cron waits until FINISHED and publishes once with verified permalink', async () => {
  const env = database({ status: 'processing', video_container_id: 'container-001',
    video_started_at: new Date().toISOString(), video_next_check_at: new Date(0).toISOString() });
  let status = 'IN_PROGRESS', publishCalls = 0;
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('fields=status')) return response({ status });
    if (u.includes('/threads_publish?')) {
      publishCalls++;
      return response({ id: 'thread-002' });
    }
    if (u.includes('fields=permalink')) return response({ permalink: 'https://www.threads.com/@demo/post/ABC' });
    throw new Error('Unexpected fetch ' + u);
  };
  const wait = await processVideoPosts(env);
  assert.equal(wait.checked, 1);
  assert.equal(wait.published, 0);
  assert.equal(publishCalls, 0);

  status = 'FINISHED';
  env.post.video_next_check_at = new Date(0).toISOString();
  const done = await processVideoPosts(env);
  assert.equal(done.published, 1);
  assert.equal(env.post.status, 'published');
  assert.equal(env.post.thread_id, 'thread-002');
  assert.equal(env.post.permalink, 'https://www.threads.com/@demo/post/ABC');
  assert.equal(publishCalls, 1);
  assert.equal((await processVideoPosts(env)).checked, 0);
  assert.equal(publishCalls, 1);
});

test('ambiguous HTTP publish result locks task against duplicate posting', async () => {
  const env = database({ status: 'processing', video_container_id: 'container-003',
    video_started_at: new Date().toISOString(), video_next_check_at: new Date(0).toISOString() });
  let publishCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('fields=status')) return response({ status: 'FINISHED' });
    if (String(url).includes('/threads_publish?')) {
      publishCalls++;
      throw new Error('network lost after POST');
    }
    throw Error('unexpected URL');
  };
  const out = await processVideoPosts(env);
  assert.equal(out.unknown, 1);
  assert.equal(env.post.status, 'publish_unknown');
  assert.match(env.post.error, /禁止自動重試/);
  assert.equal((await processVideoPosts(env)).checked, 0);
  assert.equal(publishCalls, 1);
});
