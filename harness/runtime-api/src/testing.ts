/** What a test of a runtime, or of the host, reaches for. */
export {
  startFakeGateway,
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
export { fixtureRequest, toolServerFixture, type FixtureTool, type ToolServerFixture } from './tool-server.js';
export { runtimeConformance, type ConformanceHarness, type ConformanceScript } from './conformance.js';
