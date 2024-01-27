const log = require('../util/log');
const VariablePool = require('./variable-pool');
const jsexecute = require('./jsexecute');
const environment = require('./environment');
const {StackOpcode, InputOpcode, InputType} = require('./enums.js')
const {IntermediateStackBlock, IntermediateInput, IntermediateStack, IntermediateScript, IntermediateRepresentation} = require('./intermediate');

/**
 * @fileoverview Convert intermediate representations to JavaScript functions.
 */

/* eslint-disable max-len */
/* eslint-disable prefer-template */

const sanitize = string => {
    if (typeof string !== 'string') {
        log.warn(`sanitize got unexpected type: ${typeof string}`);
        string = '' + string;
    }
    return JSON.stringify(string).slice(1, -1);
};

// Pen-related constants
const PEN_EXT = 'runtime.ext_pen';
const PEN_STATE = `${PEN_EXT}._getPenState(target)`;

/**
 * Variable pool used for factory function names.
 */
const factoryNameVariablePool = new VariablePool('factory');

/**
 * Variable pool used for generated functions (non-generator)
 */
const functionNameVariablePool = new VariablePool('fun');

/**
 * Variable pool used for generated generator functions.
 */
const generatorNameVariablePool = new VariablePool('gen');

const isSafeInputForEqualsOptimization = (input) => {
    // Only optimize constants
    if (input.opcode !== InputOpcode.CONSTANT) return false;
    // Only optimize when the constant can always be thought of as a number
    if (input.isAlwaysType(InputType.NUMBER) || input.isAlwaysType(InputType.STRING_NUM)) {
        // Never optimize 0, as if '< 0 = "" >' was optimized it would turn into
        //  `0 === +""`, which would be true even though Scratch would return false.
        return (+input.inputs.value) !== 0;
    }
    return false;
}

/**
 * A frame contains some information about the current substack being compiled.
 */
class Frame {
    constructor (isLoop) {
        /**
         * Whether the current stack runs in a loop (while, for)
         * @type {boolean}
         * @readonly
         */
        this.isLoop = isLoop;

        /**
         * Whether the current block is the last block in the stack.
         * @type {boolean}
         */
        this.isLastBlock = false;
    }
}

class JSGenerator {
    /**
     * @param {IntermediateScript} script
     * @param {IntermediateRepresentation} ir
     * @param {Target} target
     */
    constructor (script, ir, target) {
        this.script = script;
        this.ir = ir;
        this.target = target;
        this.source = '';

        this.isWarp = script.isWarp;
        this.isProcedure = script.isProcedure;
        this.warpTimer = script.warpTimer;

        /**
         * Stack of frames, most recent is last item.
         * @type {Frame[]}
         */
        this.frames = [];

        /**
         * The current Frame.
         * @type {Frame}
         */
        this.currentFrame = null;

        this.localVariables = new VariablePool('a');
        this._setupVariablesPool = new VariablePool('b');
        this._setupVariables = {};

        this.descendedIntoModulo = false;
        this.isInHat = false;

        this.debug = this.target.runtime.debug;
    }

    /**
     * Enter a new frame
     * @param {Frame} frame New frame.
     */
    pushFrame (frame) {
        this.frames.push(frame);
        this.currentFrame = frame;
    }

    /**
     * Exit the current frame
     */
    popFrame () {
        this.frames.pop();
        this.currentFrame = this.frames[this.frames.length - 1];
    }

    /**
     * @returns {boolean} true if the current block is the last command of a loop
     */
    isLastBlockInLoop () {
        for (let i = this.frames.length - 1; i >= 0; i--) {
            const frame = this.frames[i];
            if (!frame.isLastBlock) {
                return false;
            }
            if (frame.isLoop) {
                return true;
            }
        }
        return false;
    }

    /**
     * @param {IntermediateInput} block Input node to compile.
     * @returns {string} Compiled input.
     */
    descendInput (block) {
        const node = block.inputs;
        switch (block.opcode) {
        case InputOpcode.PROCEDURE_ARG_BOOLEAN:
            return `toBoolean(p${node.index})`;
        case InputOpcode.PROCEDURE_ARG_STRING_NUMBER:
            return `p${node.index}`;

        case InputOpcode.CAST_BOOLEAN:
            return `toBoolean(${this.descendInput(node.target)})`;
        case InputOpcode.CAST_NUMBER:
            return `(+${this.descendInput(node.target)} || 0)`;
        case InputOpcode.CAST_NUMBER_OR_NAN:
            return `(+${this.descendInput(node.target)})`;
        case InputOpcode.CAST_STRING:
            return `("" + ${this.descendInput(node.target)})`;

        case InputOpcode.COMPATIBILITY_LAYER:
            // Compatibility layer inputs never use flags.
            return `(${this.generateCompatibilityLayerCall(block, false)})`;

        case InputOpcode.CONSTANT:
            if (block.isAlwaysType(InputType.NUMBER)) {
                if (typeof node.value !== 'number') throw new Error(`JS: '${block.type}' type constant had ${typeof block.value} type value. Expected number.`);
                if (Object.is(node.value, -0)) return "-0";
                return node.value.toString();
            } else if (block.isAlwaysType(InputType.BOOLEAN)) {
                if (typeof node.value !== 'boolean') throw new Error(`JS: '${block.type}' type constant had ${typeof block.value} type value. Expected boolean.`);
                return node.value.toString();
            } else if (block.isSometimesType(InputType.STRING)) {
                return `"${sanitize(node.value.toString())}"`;
            } else throw new Error(`JS: Unknown constant input type '${block.type}'.`);

        case InputOpcode.SENSING_KEY_DOWN:
            return `runtime.ioDevices.keyboard.getKeyIsDown(${this.descendInput(node.key)})`;

        case InputOpcode.LIST_CONTAINS:
            return `listContains(${this.referenceVariable(node.list)}, ${this.descendInput(node.item)})`;
        case InputOpcode.LIST_CONTENTS:
            return `listContents(${this.referenceVariable(node.list)})`;
        case InputOpcode.LIST_GET: {
            if (environment.supportsNullishCoalescing) {
                if (node.index.isAlwaysType(InputType.NUMBER_NAN)) {
                    return `(${this.referenceVariable(node.list)}.value[(${this.descendInput(node.index)} | 0) - 1] ?? "")`;
                }
                if (node.index.isConstant('last')) {
                    return `(${this.referenceVariable(node.list)}.value[${this.referenceVariable(node.list)}.value.length - 1] ?? "")`;
                }
            }
            return `listGet(${this.referenceVariable(node.list)}.value, ${this.descendInput(node.index)})`;
        }
        case InputOpcode.LIST_INDEX_OF:
            return `listIndexOf(${this.referenceVariable(node.list)}, ${this.descendInput(node.item)})`;
        case InputOpcode.LIST_LENGTH:
            return `${this.referenceVariable(node.list)}.value.length`;

        case InputOpcode.LOOKS_SIZE_GET:
            return 'Math.round(target.size)';
        case InputOpcode.LOOKS_BACKDROP_NAME:
            return 'stage.getCostumes()[stage.currentCostume].name';
        case InputOpcode.LOOKS_BACKDROP_NUMBER:
            return '(stage.currentCostume + 1)';
        case InputOpcode.LOOKS_COSTUME_NAME:
            return 'target.getCostumes()[target.currentCostume].name';
        case InputOpcode.LOOKS_COSTUME_NUMBER:
            return '(target.currentCostume + 1)';

        case InputOpcode.MOTION_DIRECTION_GET:
            return 'target.direction';
        case InputOpcode.MOTION_X_GET:
            return 'limitPrecision(target.x)';
        case InputOpcode.MOTION_Y_GET:
            return 'limitPrecision(target.y)';

        case InputOpcode.SENSING_MOUSE_DOWN:
            return 'runtime.ioDevices.mouse.getIsDown()';
        case InputOpcode.SENSING_MOUSE_X:
            return 'runtime.ioDevices.mouse.getScratchX()';
        case InputOpcode.SENSING_MOUSE_Y:
            return 'runtime.ioDevices.mouse.getScratchY()';

        case InputOpcode.OP_ABS:
            return `Math.abs(${this.descendInput(node.value)})`;
        case InputOpcode.OP_ACOS:
            return `((Math.acos(${this.descendInput(node.value)}) * 180) / Math.PI)`;
        case InputOpcode.OP_ADD:
            return `(${this.descendInput(node.left)} + ${this.descendInput(node.right)})`;
        case InputOpcode.OP_AND:
            return `(${this.descendInput(node.left)} && ${this.descendInput(node.right)})`;
        case InputOpcode.OP_ASIN:
            return `((Math.asin(${this.descendInput(node.value)}) * 180) / Math.PI)`;
        case InputOpcode.OP_ATAN:
            return `((Math.atan(${this.descendInput(node.value)}) * 180) / Math.PI)`;
        case InputOpcode.OP_CEILING:
            return `Math.ceil(${this.descendInput(node.value)})`;
        case InputOpcode.OP_CONTAINS:
            return `(${this.descendInput(node.string)}.toLowerCase().indexOf(${this.descendInput(node.contains)}.toLowerCase()) !== -1)`;
        case InputOpcode.OP_COS:
            return `(Math.round(Math.cos((Math.PI * ${this.descendInput(node.value)}) / 180) * 1e10) / 1e10)`;
        case InputOpcode.OP_DIVIDE:
            return `(${this.descendInput(node.left)} / ${this.descendInput(node.right)})`;
        case InputOpcode.OP_EQUALS: {
            const left = node.left;
            const right = node.right;

            // When both operands are known to be numbers, we can use ===
            if (left.isAlwaysType(InputType.NUMBER) && right.isAlwaysType(InputType.NUMBER)) {
                return `(${this.descendInput(left)} === ${this.descendInput(right)})`;
            }
            // In certain conditions, we can use === when one of the operands is known to be a safe number.
            if (isSafeInputForEqualsOptimization(left) || isSafeInputForEqualsOptimization(right)) {
                return `(${this.descendInput(left.toType(InputType.NUMBER))} === ${this.descendInput(right.toType(InputType.NUMBER))})`;
            }
            // When either operand is known to never be a number, only use string comparison to avoid all number parsing.
            if (left.isAlwaysType(InputType.STRING_NAN) || right.isAlwaysType(InputType.STRING_NAN)) {
                return `(${this.descendInput(left.toType(InputType.STRING))}.toLowerCase() === ${this.descendInput(right.toType(InputType.STRING))}.toLowerCase())`;
            }
            // No compile-time optimizations possible - use fallback method.
            return `compareEqual(${this.descendInput(left)}, ${this.descendInput(right)})`;
        }
        case InputOpcode.OP_POW_E:
            return `Math.exp(${this.descendInput(node.value)})`;
        case InputOpcode.OP_FLOOR:
            return `Math.floor(${this.descendInput(node.value)})`;
        case InputOpcode.OP_GREATER: {
            const left = node.left;
            const right = node.right;
            // When the left operand is a number and the right operand is a number or NaN, we can use >
            if (left.isAlwaysType(InputType.NUMBER) && right.isAlwaysType(InputType.NUMBER_OR_NAN)) {
                return `(${this.descendInput(left)} > ${this.descendInput(right)})`;
            }
            // When the left operand is a number or NaN and the right operand is a number, we can negate <=
            if (left.isAlwaysType(InputType.NUMBER_OR_NAN) && right.isAlwaysType(InputType.NUMBER)) {
                return `!(${this.descendInput(left)} <= ${this.descendInput(right)})`;
            }
            // When either operand is known to never be a number, avoid all number parsing.
            if (left.isAlwaysType(InputType.STRING_NAN) || right.isAlwaysType(InputType.STRING_NAN)) {
                return `(${this.descendInput(left.toType(InputType.STRING))}.toLowerCase() > ${this.descendInput(right.toType(InputType.STRING))}.toLowerCase())`;
            }
            // No compile-time optimizations possible - use fallback method.
            return `compareGreaterThan(${this.descendInput(left)}, ${this.descendInput(right)})`;
        }
        case InputOpcode.OP_JOIN:
            return `(${this.descendInput(node.left)} + ${this.descendInput(node.right)})`;
        case InputOpcode.OP_LENGTH:
            return `${this.descendInput(node.string)}.length`;
        case InputOpcode.OP_LESS: {
            const left = node.left;
            const right = node.right;
            // When the left operand is a number or NaN and the right operand is a number, we can use <
            if (left.isAlwaysType(InputType.NUMBER) && right.isAlwaysType(InputType.NUMBER_OR_NAN)) {
                return `(${this.descendInput(left.toType(InputType.NUMBER_OR_NAN))} < ${this.descendInput(right.toType(InputType.NUMBER))})`;
            }
            // When the left operand is a number and the right operand is a number or NaN, we can negate >=
            if (left.isAlwaysType(InputType.NUMBER_OR_NAN) && right.isAlwaysType(InputType.NUMBER)) {
                return `!(${this.descendInput(left.toType(InputType.NUMBER))} >= ${this.descendInput(right.toType(InputType.NUMBER_OR_NAN))})`;
            }
            // When either operand is known to never be a number, avoid all number parsing.
            if (left.isAlwaysType(InputType.STRING_NAN) || right.isAlwaysType(InputType.STRING_NAN)) {
                return `(${this.descendInput(left.toType(InputType.STRING))}.toLowerCase() < ${this.descendInput(right.toType(InputType.STRING))}.toLowerCase())`;
            }
            // No compile-time optimizations possible - use fallback method.
            return `compareLessThan(${this.descendInput(left)}, ${this.descendInput(right)})`;
        }
        case InputOpcode.OP_LETTER_OF:
            return `((${this.descendInput(node.string)})[(${this.descendInput(node.letter)} | 0) - 1] || "")`;
        case InputOpcode.OP_LOG_E:
            return `Math.log(${this.descendInput(node.value)})`;
        case InputOpcode.OP_LOG_10:
            return `(Math.log(${this.descendInput(node.value)}) / Math.LN10)`;
        case InputOpcode.OP_MOD:
            this.descendedIntoModulo = true;
            return `mod(${this.descendInput(node.left)}, ${this.descendInput(node.right)})`;
        case InputOpcode.OP_MULTIPLY:
            return `(${this.descendInput(node.left)} * ${this.descendInput(node.right)})`;
        case InputOpcode.OP_NOT:
            return `!${this.descendInput(node.operand)}`;
        case InputOpcode.OP_OR:
            return `(${this.descendInput(node.left)} || ${this.descendInput(node.right)})`;
        case InputOpcode.OP_RANDOM:
            if (node.useInts) {
                return `randomInt(${this.descendInput(node.low)}, ${this.descendInput(node.high)})`;
            }
            if (node.useFloats) {
                return `randomFloat(${this.descendInput(node.low)}, ${this.descendInput(node.high)})`;
            }
            return `runtime.ext_scratch3_operators._random(${this.descendInput(node.low)}, ${this.descendInput(node.high)})`;
        case InputOpcode.OP_ROUND:
            return `Math.round(${this.descendInput(node.value)})`;
        case InputOpcode.OP_SIN:
            return `(Math.round(Math.sin((Math.PI * ${this.descendInput(node.value)}) / 180) * 1e10) / 1e10)`;
        case InputOpcode.OP_SQRT:
            return `Math.sqrt(${this.descendInput(node.value)})`;
        case InputOpcode.OP_SUBTRACT:
            return `(${this.descendInput(node.left)} - ${this.descendInput(node.right)})`;
        case InputOpcode.OP_TAN:
            return `tan(${this.descendInput(node.value)})`;
        case InputOpcode.OP_POW_10:
            return `(10 ** ${this.descendInput(node.value)})`;

        case InputOpcode.SENSING_ANSWER:
            return `runtime.ext_scratch3_sensing._answer`;
        case InputOpcode.SENSING_COLOR_TOUCHING_COLOR:
            return `target.colorIsTouchingColor(colorToList(${this.descendInput(node.target)}), colorToList(${this.descendInput(node.mask)}))`;
        case InputOpcode.SENSING_TIME_DATE:
            return `(new Date().getDate())`;
        case InputOpcode.SENSING_TIME_WEEKDAY:
            return `(new Date().getDay() + 1)`;
        case InputOpcode.SENSING_TIME_DAYS_SINCE_2000:
            return 'daysSince2000()';
        case InputOpcode.SENSING_DISTANCE:
            // TODO: on stages, this can be computed at compile time
            return `distance(${this.descendInput(node.target)})`;
        case InputOpcode.SENSING_TIME_HOUR:
            return `(new Date().getHours())`;
        case InputOpcode.SENSING_TIME_MINUTE:
            return `(new Date().getMinutes())`;
        case InputOpcode.SENSING_TIME_MONTH:
            return `(new Date().getMonth() + 1)`;
        case InputOpcode.SENSING_OF:
            return `runtime.ext_scratch3_sensing.getAttributeOf({OBJECT: ${this.descendInput(node.object)}, PROPERTY: "${sanitize(node.property)}" })`;
        case InputOpcode.SENSING_OF_VOLUME: {
            const targetRef = this.descendTargetReference(node.object);
            return `(${targetRef} ? ${targetRef}.volume : 0)`;
        } case InputOpcode.SENSING_OF_BACKDROP_NUMBER:
            return `(stage.currentCostume + 1)`;
        case InputOpcode.SENSING_OF_BACKDROP_NAME:
            return `stage.getCostumes()[stage.currentCostume].name`;
        case InputOpcode.SENSING_OF_POS_X: {
            const targetRef = this.descendTargetReference(node.object);
            return `(${targetRef} ? ${targetRef}.x : 0)`;
        } case InputOpcode.SENSING_OF_POS_Y: {
            const targetRef = this.descendTargetReference(node.object);
            return `(${targetRef} ? ${targetRef}.y : 0)`;
        } case InputOpcode.SENSING_OF_DIRECTION: {
            const targetRef = this.descendTargetReference(node.object);
            return `(${targetRef} ? ${targetRef}.direction : 0)`;
        } case InputOpcode.SENSING_OF_COSTUME_NUMBER: {
            const targetRef = this.descendTargetReference(node.object);
            return `(${targetRef} ? ${targetRef}.currentCostume + 1 : 0)`;
        } case InputOpcode.SENSING_OF_COSTUME_NAME: {
            const targetRef = this.descendTargetReference(node.object);
            return `(${targetRef} ? ${targetRef}.getCostumes()[${targetRef}.currentCostume].name : 0)`;
        } case InputOpcode.SENSING_OF_SIZE: {
            const targetRef = this.descendTargetReference(node.object);
            return `(${targetRef} ? ${targetRef}.size : 0)`;
        } case InputOpcode.SENSING_OF_VAR: {
            const targetRef = this.descendTargetReference(node.object);
            const varRef = this.evaluateOnce(`${targetRef} && ${targetRef}.lookupVariableByNameAndType("${sanitize(node.property)}", "", true)`);
            return `(${varRef} ? ${varRef}.value : 0)`;
        } case InputOpcode.SENSING_TIME_SECOND:
            return `(new Date().getSeconds())`;
        case InputOpcode.SENSING_TOUCHING_OBJECT:
            return `target.isTouchingObject(${this.descendInput(node.object)})`;
        case InputOpcode.SENSING_TOUCHING_COLOR:
            return `target.isTouchingColor(colorToList(${this.descendInput(node.color)}))`;
        case InputOpcode.SENSING_USERNAME:
            return 'runtime.ioDevices.userData.getUsername()';
        case InputOpcode.SENSING_TIME_YEAR:
            return `(new Date().getFullYear())`;

        case InputOpcode.SENSING_TIMER_GET:
            return 'runtime.ioDevices.clock.projectTimer()';

        case InputOpcode.TW_KEY_LAST_PRESSED:
            return 'runtime.ioDevices.keyboard.getLastKeyPressed()';

        case InputOpcode.VAR_GET:
            return `${this.referenceVariable(node.variable)}.value`;

        default:
            log.warn(`JS: Unknown input: ${block.opcode}`, node);
            throw new Error(`JS: Unknown input: ${block.opcode}`);
        }
    }

    /**
     * @param {IntermediateStackBlock} block Stacked block to compile.
     */
    descendStackedBlock (block) {
        const node = block.inputs;
        switch (block.opcode) {
        case StackOpcode.ADDON_CALL: {
            const inputs = this.descendInputRecord(node.arguments);
            const blockFunction = `runtime.getAddonBlock("${sanitize(node.code)}").callback`;
            const blockId = `"${sanitize(node.blockId)}"`;
            this.source += `yield* executeInCompatibilityLayer(${inputs}, ${blockFunction}, ${this.isWarp}, false, ${blockId});\n`;
            break;
        }

        case StackOpcode.COMPATIBILITY_LAYER: {
            // If the last command in a loop returns a promise, immediately continue to the next iteration.
            // If you don't do this, the loop effectively yields twice per iteration and will run at half-speed.
            const isLastInLoop = this.isLastBlockInLoop();
            this.source += `${this.generateCompatibilityLayerCall(block, isLastInLoop)};\n`;
            if (isLastInLoop) {
                this.source += 'if (hasResumedFromPromise) {hasResumedFromPromise = false;continue;}\n';
            }
            break;
        }

        case StackOpcode.CONTROL_CLONE_CREATE:
            this.source += `runtime.ext_scratch3_control._createClone(${this.descendInput(node.target)}, target);\n`;
            break;
        case StackOpcode.CONTROL_CLONE_DELETE:
            this.source += 'if (!target.isOriginal) {\n';
            this.source += '  runtime.disposeTarget(target);\n';
            this.source += '  runtime.stopForTarget(target);\n';
            this.retire();
            this.source += '}\n';
            break;
        case StackOpcode.CONTROL_FOR:
            const index = this.localVariables.next();
            this.source += `var ${index} = 0; `;
            this.source += `while (${index} < ${this.descendInput(node.count)}) { `;
            this.source += `${index}++; `;
            this.source += `${this.referenceVariable(node.variable)}.value = ${index};\n`;
            this.descendStack(node.do, new Frame(true));
            this.yieldLoop();
            this.source += '}\n';
            break;
        case StackOpcode.CONTROL_IF_ELSE:
            this.source += `if (${this.descendInput(node.condition)}) {\n`;
            this.descendStack(node.whenTrue, new Frame(false));
            // only add the else branch if it won't be empty
            // this makes scripts have a bit less useless noise in them
            if (node.whenFalse.blocks.length) {
                this.source += `} else {\n`;
                this.descendStack(node.whenFalse, new Frame(false));
            }
            this.source += `}\n`;
            break;
        case StackOpcode.CONTROL_REPEAT: {
            const i = this.localVariables.next();
            this.source += `for (var ${i} = ${this.descendInput(node.times)}; ${i} >= 0.5; ${i}--) {\n`;
            this.descendStack(node.do, new Frame(true));
            this.yieldLoop();
            this.source += `}\n`;
            break;
        }
        case StackOpcode.CONTROL_STOP_ALL:
            this.source += 'runtime.stopAll();\n';
            this.retire();
            break;
        case StackOpcode.CONTROL_STOP_OTHERS:
            this.source += 'runtime.stopForTarget(target, thread);\n';
            break;
        case StackOpcode.CONTROL_STOP_SCRIPT:
            if (this.isProcedure) {
                this.source += 'return;\n';
            } else {
                this.retire();
            }
            break;
        case StackOpcode.CONTROL_WAIT: {
            const duration = this.localVariables.next();
            this.source += `thread.timer = timer();\n`;
            this.source += `var ${duration} = Math.max(0, 1000 * ${this.descendInput(node.seconds)});\n`;
            this.requestRedraw();
            // always yield at least once, even on 0 second durations
            this.yieldNotWarp();
            this.source += `while (thread.timer.timeElapsed() < ${duration}) {\n`;
            this.yieldStuckOrNotWarp();
            this.source += '}\n';
            this.source += 'thread.timer = null;\n';
            break;
        }
        case StackOpcode.CONTROL_WAIT_UNTIL: {
            this.source += `while (!${this.descendInput(node.condition)}) {\n`;
            this.yieldStuckOrNotWarp();
            this.source += `}\n`;
            break;
        }
        case StackOpcode.CONTROL_WHILE:
            this.source += `while (${this.descendInput(node.condition)}) {\n`;
            this.descendStack(node.do, new Frame(true));
            if (node.warpTimer) {
                this.yieldStuckOrNotWarp();
            } else {
                this.yieldLoop();
            }
            this.source += `}\n`;
            break;

        case StackOpcode.EVENT_BROADCAST:
            this.source += `startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: ${this.descendInput(node.broadcast)} });\n`;
            break;
        case StackOpcode.EVENT_BROADCAST_AND_WAIT:
            this.source += `yield* waitThreads(startHats("event_whenbroadcastreceived", { BROADCAST_OPTION: ${this.descendInput(node.broadcast)} }));\n`;
            this.yielded();
            break;

        case StackOpcode.LIST_ADD: {
            const list = this.referenceVariable(node.list);
            this.source += `${list}.value.push(${this.descendInput(node.item)});\n`;
            this.source += `${list}._monitorUpToDate = false;\n`;
            break;
        }
        case StackOpcode.LIST_DELETE: {
            const list = this.referenceVariable(node.list);
            if (node.index.isConstant('last')) {
                this.source += `${list}.value.pop();\n`;
                this.source += `${list}._monitorUpToDate = false;\n`;
                break;
            }
            if (node.index.isConstant(1)) {
                this.source += `${list}.value.shift();\n`;
                this.source += `${list}._monitorUpToDate = false;\n`;
                break;
            }
            // do not need a special case for all as that is handled in IR generation (list.deleteAll)
            this.source += `listDelete(${list}, ${this.descendInput(node.index)});\n`;
            break;
        }
        case StackOpcode.LIST_DELETE_ALL:
            this.source += `${this.referenceVariable(node.list)}.value = [];\n`;
            break;
        case StackOpcode.LIST_HIDE:
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.list.id)}", element: "checkbox", value: false }, runtime);\n`;
            break;
        case StackOpcode.LIST_INSERT: {
            const list = this.referenceVariable(node.list);
            const item = this.descendInput(node.item);
            if (node.index.isConstant(1)) {
                this.source += `${list}.value.unshift(${item});\n`;
                this.source += `${list}._monitorUpToDate = false;\n`;
                break;
            }
            this.source += `listInsert(${list}, ${this.descendInput(node.index)}, ${item});\n`;
            break;
        }
        case StackOpcode.LIST_REPLACE:
            this.source += `listReplace(${this.referenceVariable(node.list)}, ${this.descendInput(node.index)}, ${this.descendInput(node.item)});\n`;
            break;
        case StackOpcode.LIST_SHOW:
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.list.id)}", element: "checkbox", value: true }, runtime);\n`;
            break;

        case StackOpcode.LOOKS_LAYER_BACKWARD:
            if (!this.target.isStage) {
                this.source += `target.goBackwardLayers(${this.descendInput(node.layers)});\n`;
            }
            break;
        case StackOpcode.LOOKS_EFFECT_CLEAR:
            this.source += 'target.clearEffects();\n';
            break;
        case StackOpcode.LOOKS_EFFECT_CHANGE:
            if (this.target.effects.hasOwnProperty(node.effect)) {
                this.source += `target.setEffect("${sanitize(node.effect)}", runtime.ext_scratch3_looks.clampEffect("${sanitize(node.effect)}", ${this.descendInput(node.value)} + target.effects["${sanitize(node.effect)}"]));\n`;
            }
            break;
        case StackOpcode.LOOKS_SIZE_CHANGE:
            this.source += `target.setSize(target.size + ${this.descendInput(node.size)});\n`;
            break;
        case StackOpcode.LOOKS_LAYER_FORWARD:
            if (!this.target.isStage) {
                this.source += `target.goForwardLayers(${this.descendInput(node.layers)});\n`;
            }
            break;
        case StackOpcode.LOOKS_LAYER_BACK:
            if (!this.target.isStage) {
                this.source += 'target.goToBack();\n';
            }
            break;
        case StackOpcode.LOOKS_LAYER_FRONT:
            if (!this.target.isStage) {
                this.source += 'target.goToFront();\n';
            }
            break;
        case StackOpcode.LOOKS_HIDE:
            this.source += 'target.setVisible(false);\n';
            this.source += 'runtime.ext_scratch3_looks._renderBubble(target);\n';
            break;
        case StackOpcode.LOOKS_BACKDROP_NEXT:
            this.source += 'runtime.ext_scratch3_looks._setBackdrop(stage, stage.currentCostume + 1, true);\n';
            break;
        case StackOpcode.LOOKS_COSTUME_NEXT:
            this.source += 'target.setCostume(target.currentCostume + 1);\n';
            break;
        case StackOpcode.LOOKS_EFFECT_SET:
            if (this.target.effects.hasOwnProperty(node.effect)) {
                this.source += `target.setEffect("${sanitize(node.effect)}", runtime.ext_scratch3_looks.clampEffect("${sanitize(node.effect)}", ${this.descendInput(node.value)}));\n`;
            }
            break;
        case StackOpcode.LOOKS_SIZE_SET:
            this.source += `target.setSize(${this.descendInput(node.size)});\n`;
            break;
        case StackOpcode.LOOKS_SHOW:
            this.source += 'target.setVisible(true);\n';
            this.source += 'runtime.ext_scratch3_looks._renderBubble(target);\n';
            break;
        case StackOpcode.LOOKS_BACKDROP_SET:
            this.source += `runtime.ext_scratch3_looks._setBackdrop(stage, ${this.descendInput(node.backdrop)});\n`;
            break;
        case StackOpcode.LOOKS_COSTUME_SET:
            this.source += `runtime.ext_scratch3_looks._setCostume(target, ${this.descendInput(node.costume)});\n`;
            break;

        case StackOpcode.MOTION_X_CHANGE:
            this.source += `target.setXY(target.x + ${this.descendInput(node.dx)}, target.y);\n`;
            break;
        case StackOpcode.MOTION_Y_CHANGE:
            this.source += `target.setXY(target.x, target.y + ${this.descendInput(node.dy)});\n`;
            break;
        case StackOpcode.MOTION_IF_ON_EDGE_BOUNCE:
            this.source += `runtime.ext_scratch3_motion._ifOnEdgeBounce(target);\n`;
            break;
        case StackOpcode.MOTION_DIRECTION_SET:
            this.source += `target.setDirection(${this.descendInput(node.direction)});\n`;
            break;
        case StackOpcode.MOTION_ROTATION_STYLE_SET:
            this.source += `target.setRotationStyle("${sanitize(node.style)}");\n`;
            break;
        case StackOpcode.MOTION_X_SET: // fallthrough
        case StackOpcode.MOTION_Y_SET: // fallthrough
        case StackOpcode.MOTION_XY_SET: {
            this.descendedIntoModulo = false;
            const x = 'x' in node ? this.descendInput(node.x) : 'target.x';
            const y = 'y' in node ? this.descendInput(node.y) : 'target.y';
            this.source += `target.setXY(${x}, ${y});\n`;
            if (this.descendedIntoModulo) {
                this.source += `if (target.interpolationData) target.interpolationData = null;\n`;
            }
            break;
        }
        case StackOpcode.MOTION_STEP:
            this.source += `runtime.ext_scratch3_motion._moveSteps(${this.descendInput(node.steps)}, target);\n`;
            break;

        case StackOpcode.NOP:
            // todo: remove noop entirely
            break;

        case StackOpcode.PEN_CLEAR:
            this.source += `${PEN_EXT}.clear();\n`;
            break;
        case StackOpcode.PEN_DOWN:
            this.source += `${PEN_EXT}._penDown(target);\n`;
            break;
        case StackOpcode.PEN_COLOR_PARAM_CHANGE:
            this.source += `${PEN_EXT}._setOrChangeColorParam(${this.descendInput(node.param)}, ${this.descendInput(node.value)}, ${PEN_STATE}, true);\n`;
            break;
        case StackOpcode.PEN_SIZE_CHANGE:
            this.source += `${PEN_EXT}._changePenSizeBy(${this.descendInput(node.size)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_HUE_CHANGE_LEGACY:
            this.source += `${PEN_EXT}._changePenHueBy(${this.descendInput(node.hue)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_SHADE_CHANGE_LEGACY:
            this.source += `${PEN_EXT}._changePenShadeBy(${this.descendInput(node.shade)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_HUE_SET_LEGACY:
            this.source += `${PEN_EXT}._setPenHueToNumber(${this.descendInput(node.hue)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_SHADE_SET_LEGACY:
            this.source += `${PEN_EXT}._setPenShadeToNumber(${this.descendInput(node.shade)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_SET:
            this.source += `${PEN_EXT}._setPenColorToColor(${this.descendInput(node.color)}, target);\n`;
            break;
        case StackOpcode.PEN_COLOR_PARAM_SET:
            this.source += `${PEN_EXT}._setOrChangeColorParam(${this.descendInput(node.param)}, ${this.descendInput(node.value)}, ${PEN_STATE}, false);\n`;
            break;
        case StackOpcode.PEN_SIZE_SET:
            this.source += `${PEN_EXT}._setPenSizeTo(${this.descendInput(node.size)}, target);\n`;
            break;
        case StackOpcode.PEN_STAMP:
            this.source += `${PEN_EXT}._stamp(target);\n`;
            break;
        case StackOpcode.PEN_UP:
            this.source += `${PEN_EXT}._penUp(target);\n`;
            break;

        case StackOpcode.PROCEDURE_CALL: {
            const procedureCode = node.code;
            const procedureVariant = node.variant;
            const procedureData = this.ir.procedures[procedureVariant];
            if (procedureData.stack === null) {
                // TODO still need to evaluate arguments
                break;
            }

            const yieldForRecursion = !this.isWarp && procedureCode === this.script.procedureCode;
            if (yieldForRecursion) {
                this.yieldNotWarp();
            }

            if (procedureData.yields) {
                this.source += 'yield* ';
            }
            this.source += `thread.procedures["${sanitize(procedureVariant)}"](`;
            // Only include arguments if the procedure accepts any.
            if (procedureData.arguments.length) {
                const args = [];
                for (const input of node.arguments) {
                    args.push(this.descendInput(input));
                }
                this.source += args.join(',');
            }
            this.source += `);\n`;
            // Variable input types may have changes after a procedure call.
            break;
        }
        case 'procedures.return':
            this.stopScriptAndReturn(this.descendInput(node.value).asSafe());
            break;

        case StackOpcode.SENSING_TIMER_RESET:
            this.source += 'runtime.ioDevices.clock.resetProjectTimer();\n';
            break;

        case StackOpcode.DEBUGGER:
            this.source += 'debugger;\n';
            break;

        case StackOpcode.VAR_HIDE:
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.variable.id)}", element: "checkbox", value: false }, runtime);\n`;
            break;
        case StackOpcode.VAR_SET: {
            const varReference = this.referenceVariable(node.variable);
            this.source += `${varReference}.value = ${this.descendInput(node.value)};\n`;
            if (node.variable.isCloud) {
                this.source += `runtime.ioDevices.cloud.requestUpdateVariable("${sanitize(node.variable.name)}", ${varReference}.value);\n`;
            }
            break;
        }
        case StackOpcode.VAR_SHOW:
            this.source += `runtime.monitorBlocks.changeBlock({ id: "${sanitize(node.variable.id)}", element: "checkbox", value: true }, runtime);\n`;
            break;

        case StackOpcode.VISUAL_REPORT: {
            const value = this.localVariables.next();
            this.source += `const ${value} = ${this.descendInput(node.input)};`;
            // blocks like legacy no-ops can return a literal `undefined`
            this.source += `if (${value} !== undefined) runtime.visualReport("${sanitize(this.script.topBlockId)}", ${value});\n`;
            break;
        }

        default:
            log.warn(`JS: Unknown stacked block: ${block.opcode}`, node);
            throw new Error(`JS: Unknown stacked block: ${block.opcode}`);
        }
    }

    /**
     * Compiles a reference to a target.
     * @param {IntermediateInput} input The target reference. Must be a string.
     * @returns {string} The compiled target reference
     */
    descendTargetReference(input) {
        if (!input.isAlwaysType(InputType.STRING))
            throw new Error(`JS: Object references must be strings!`);
        if (input.isConstant('_stage_')) return 'stage';
        return this.evaluateOnce(`runtime.getSpriteTargetByName(${this.descendInput(input)})`);
    }

    /**
     * Compile a Record of input objects into a safe JS string.
     * @param {Record<string, unknown>} inputs
     * @returns {string}
     */
    descendInputRecord (inputs) {
        let result = '{';
        for (const name of Object.keys(inputs)) {
            const node = inputs[name];
            result += `"${sanitize(name)}":${this.descendInput(node)},`;
        }
        result += '}';
        return result;
    }

    /**
     * @param {IntermediateStack} stack 
     * @param {Frame} frame 
     */
    descendStack (stack, frame) {
        // Entering a stack -- all bets are off.
        // TODO: allow if/else to inherit values
        this.pushFrame(frame);

        for (let i = 0; i < stack.blocks.length; i++) {
            frame.isLastBlock = i === stack.blocks.length - 1;
            this.descendStackedBlock(stack.blocks[i]);
        }

        // Leaving a stack -- any assumptions made in the current stack do not apply outside of it
        // TODO: in if/else this might create an extra unused object
        this.popFrame();
    }

    referenceVariable (variable) {
        if (variable.scope === 'target') {
            return this.evaluateOnce(`target.variables["${sanitize(variable.id)}"]`);
        }
        return this.evaluateOnce(`stage.variables["${sanitize(variable.id)}"]`);
    }

    descendAddonCall (node) {
        const inputs = this.descendInputRecord(node.arguments);
        const blockFunction = `runtime.getAddonBlock("${sanitize(node.code)}").callback`;
        const blockId = `"${sanitize(node.blockId)}"`;
        return `yield* executeInCompatibilityLayer(${inputs}, ${blockFunction}, ${this.isWarp}, false, ${blockId})`;
    }

    evaluateOnce (source) {
        if (Object.prototype.hasOwnProperty.call(this._setupVariables, source)) {
            return this._setupVariables[source];
        }
        const variable = this._setupVariablesPool.next();
        this._setupVariables[source] = variable;
        return variable;
    }

    retire () {
        // After running retire() (sets thread status and cleans up some unused data), we need to return to the event loop.
        // When in a procedure, return will only send us back to the previous procedure, so instead we yield back to the sequencer.
        // Outside of a procedure, return will correctly bring us back to the sequencer.
        if (this.isProcedure) {
            this.source += 'retire(); yield;\n';
        } else {
            this.source += 'retire(); return;\n';
        }
    }

    stopScript () {
        if (this.isProcedure) {
            this.source += 'return "";\n';
        } else {
            this.retire();
        }
    }

    /**
     * @param {string} valueJS JS code of value to return.
     */
    stopScriptAndReturn (valueJS) {
        if (this.isProcedure) {
            this.source += `return ${valueJS};\n`;
        } else {
            this.retire();
        }
    }

    yieldLoop () {
        if (this.warpTimer) {
            this.yieldStuckOrNotWarp();
        } else {
            this.yieldNotWarp();
        }
    }

    /**
     * Write JS to yield the current thread if warp mode is disabled.
     */
    yieldNotWarp () {
        if (!this.isWarp) {
            this.source += 'yield;\n';
            this.yielded();
        }
    }

    /**
     * Write JS to yield the current thread if warp mode is disabled or if the script seems to be stuck.
     */
    yieldStuckOrNotWarp () {
        if (this.isWarp) {
            this.source += 'if (isStuck()) yield;\n';
        } else {
            this.source += 'yield;\n';
        }
        this.yielded();
    }

    yielded () {
        if (!this.script.yields) {
            throw new Error('Script yielded but is not marked as yielding.');
        }
        // Control may have been yielded to another script -- all bets are off.
    }

    /**
     * Write JS to request a redraw.
     */
    requestRedraw () {
        this.source += 'runtime.requestRedraw();\n';
    }

    /**
     * Generate a call into the compatibility layer.
     * @param {IntermediateStackBlock} block The block to generate from.
     * @param {boolean} setFlags Whether flags should be set describing how this function was processed.
     * @param {string|null} [frameName] Name of the stack frame variable, if any
     * @returns {string} The JS of the call.
     */
    generateCompatibilityLayerCall (block, setFlags) {
        const node = block.inputs;
        const opcode = node.opcode;

        let result = 'yield* executeInCompatibilityLayer({';

        for (const inputName of Object.keys(node.inputs)) {
            const input = node.inputs[inputName];
            const compiledInput = this.descendInput(input);
            result += `"${sanitize(inputName)}":${compiledInput},`;
        }
        for (const fieldName of Object.keys(node.fields)) {
            const field = node.fields[fieldName];
            result += `"${sanitize(fieldName)}":"${sanitize(field)}",`;
        }
        const opcodeFunction = this.evaluateOnce(`runtime.getOpcodeFunction("${sanitize(opcode)}")`);
        result += `}, ${opcodeFunction}, ${this.isWarp}, ${setFlags}, "${sanitize(node.id)}", ${frameName})`;

        return result;
    }

    getScriptFactoryName () {
        return factoryNameVariablePool.next();
    }

    getScriptName (yields) {
        let name = yields ? generatorNameVariablePool.next() : functionNameVariablePool.next();
        if (this.isProcedure) {
            const simplifiedProcedureCode = this.script.procedureCode
                .replace(/%[\w]/g, '') // remove arguments
                .replace(/[^a-zA-Z0-9]/g, '_') // remove unsafe
                .substring(0, 20); // keep length reasonable
            name += `_${simplifiedProcedureCode}`;
        }
        return name;
    }

    /**
     * Generate the JS to pass into eval() based on the current state of the compiler.
     * @returns {string} JS to pass into eval()
     */
    createScriptFactory () {
        let script = '';

        // Setup the factory
        script += `(function ${this.getScriptFactoryName()}(thread) { `;
        script += 'const target = thread.target; ';
        script += 'const runtime = target.runtime; ';
        script += 'const stage = runtime.getTargetForStage();\n';
        for (const varValue of Object.keys(this._setupVariables)) {
            const varName = this._setupVariables[varValue];
            script += `const ${varName} = ${varValue};\n`;
        }

        // Generated script
        script += 'return ';
        if (this.script.yields) {
            script += `function* `;
        } else {
            script += `function `;
        }
        script += this.getScriptName(this.script.yields);
        script += ' (';
        if (this.script.arguments.length) {
            const args = [];
            for (let i = 0; i < this.script.arguments.length; i++) {
                args.push(`p${i}`);
            }
            script += args.join(',');
        }
        script += ') {\n';

        script += this.source;

        script += '}; })';

        return script;
    }

    /**
     * Compile this script.
     * @returns {Function} The factory function for the script.
     */
    compile () {
        if (this.script.stack) {
            this.descendStack(this.script.stack, new Frame(false));
        }
        this.stopScript();

        const factory = this.createScriptFactory();
        const fn = jsexecute.scopedEval(factory);

        if (this.debug) {
            log.info(`JS: ${this.target.getName()}: compiled ${this.script.procedureCode || 'script'}`, factory);
        }

        if (JSGenerator.testingApparatus) {
            JSGenerator.testingApparatus.report(this, factory);
        }

        return fn;
    }
}

// Test hook used by automated snapshot testing.
JSGenerator.testingApparatus = null;

module.exports = JSGenerator;
