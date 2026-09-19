/** What a test of a runtime, or of the host, reaches for. */
export {
  FAKE_EMBED_DIMENSIONS,
  fakeEmbedding,
  startFakeGateway,
  type EmbeddingResponder,
  type FakeEmbeddingCall,
  type FakeEmbeddingReply,
  type FakeGateway,
  type FakeGatewayCall,
  type FakeGatewayMessage,
  type FakeReply,
  type FakeToolCall,
  type Responder,
} from './gateway.js';
export {
  ScriptedRuntime,
  TrajectoryShape,
  parseTrajectory,
  readTrajectory,
  scriptedRuntime,
  type Trajectory,
  type TrajectoryStep,
} from './scripted.js';
export {
  RECORDS_SEARCH,
  fixtureRequest,
  toolServerFixture,
  type FixtureTool,
  type ToolServerFixture,
} from './tool-server.js';
export {
  collectRunEvents,
  runtimeConformance,
  type ConformanceHarness,
  type ConformanceScript,
} from './conformance.js';
