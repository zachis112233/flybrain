"use strict";

var assert = require("node:assert/strict");
var core = require("../snake/snake-core.js");

function state(overrides) {
  return Object.assign({
    width: 10,
    height: 10,
    snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }],
    food: { x: 8, y: 5 },
    direction: 1,
    score: 0,
    steps: 0,
    alive: true
  }, overrides || {});
}

assert.equal(core.rotateDirection(0, "left"), 3);
assert.equal(core.rotateDirection(0, "right"), 1);
assert.equal(core.rotateDirection(3, "right"), 0);
assert.equal(core.rotateDirection(2, "forward"), 2);

var ahead = core.foodCueWeights(state());
assert.ok(ahead.forward > ahead.left);
assert.ok(ahead.forward > ahead.right);

var toLeft = core.foodCueWeights(state({ food: { x: 5, y: 2 } }));
assert.ok(toLeft.left > toLeft.right);
assert.ok(toLeft.left > toLeft.forward);

var behind = core.foodCueWeights(state({ food: { x: 2, y: 5 } }));
assert.equal(behind.forward, 0);
assert.ok(Math.abs(behind.left - behind.right) < 1e-12);

var wallState = state({
  snake: [{ x: 0, y: 5 }, { x: 0, y: 6 }],
  direction: 0
});
var wallDanger = core.senseDanger(wallState, 3);
assert.equal(wallDanger.left, 1);
assert.equal(wallDanger.forward, 0);

var bodyState = state({
  snake: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 4, y: 5 }],
  direction: 1
});
assert.equal(core.senseDanger(bodyState, 3).forward, 1);

assert.equal(core.chooseRelativeCommand({ left: 2, forward: 1, right: 0 }).command, "left");
assert.equal(core.chooseRelativeCommand({ left: 0, forward: 0, right: 0 }).command, "forward");
assert.equal(core.chooseRelativeCommand({ left: 2, forward: 2, right: 1 }).command, "forward");
assert.equal(core.chooseRelativeCommand({ left: NaN, forward: 1, right: Infinity }).command, "forward");

var rngA = core.createSeededRandom(42);
var rngB = core.createSeededRandom(42);
for (var i = 0; i < 20; i++) assert.equal(rngA(), rngB());

var eating = state({
  snake: [{ x: 2, y: 2 }, { x: 1, y: 2 }, { x: 0, y: 2 }],
  food: { x: 3, y: 2 },
  direction: 1
});
var eaten = core.stepSnake(eating, "forward", core.createSeededRandom(7));
assert.equal(eaten.lastEvent, "ate");
assert.equal(eaten.score, 1);
assert.equal(eaten.snake.length, 4);
assert.ok(!eaten.snake.some(function (cell) {
  return core.sameCell(cell, eaten.food);
}));

var intoWall = core.stepSnake(state({
  snake: [{ x: 9, y: 5 }, { x: 8, y: 5 }],
  direction: 1
}), "forward", Math.random);
assert.equal(intoWall.alive, false);
assert.equal(intoWall.lastEvent, "collision");

var tailVacate = state({
  snake: [{ x: 2, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
  food: { x: 8, y: 8 },
  direction: 2
});
var intoTail = core.stepSnake(tailVacate, "forward", Math.random);
assert.equal(intoTail.alive, true);
assert.deepEqual(intoTail.snake[0], { x: 2, y: 2 });

var initial = core.createInitialState({
  width: 20,
  height: 20,
  random: core.createSeededRandom(11)
});
assert.equal(initial.snake.length, 4);
assert.ok(!initial.snake.some(function (cell) {
  return core.sameCell(cell, initial.food);
}));

console.log("snake-core: all tests passed");
