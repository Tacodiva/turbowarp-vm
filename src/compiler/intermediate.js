/**
 * @fileoverview Common intermediates shared amongst parts of the compiler.
 */

/**
 * Describes a 'stackable' block (eg. show)
 */
 class IntermediateStack {
    /**
     * @param {import("./enums").StackOpcode} opcode 
     * @param {Object} inputs 
     */
    constructor(opcode, inputs = {}) {
        /**
         * The type of the stackable block.
         * @type {import("./enums").StackOpcode}
         */
        this.opcode = opcode;

        /**
         * The 
         * @type {Object} 
         */
        this.inputs = inputs;
    }
}

/**
 * Describes an input to a block.
 * This could be a constant, variable or math operation.
 */
class IntermediateInput {
    /**
     * @param {import("./enums").InputOpcode} opcode 
     * @param {import("./enums").InputType} type
     * @param {Object} inputs 
     */
    constructor(opcode, type, inputs = {}) {
        /**
         * @type {import("./enums").InputOpcode}
         */
        this.opcode = opcode;


        /**
         * @type {import("./enums").InputType}
         */
        this.type = type;

        /**
         * @type {Object}
         */
        this.inputs = inputs;
    }
}

/**
 * An IntermediateScript describes a single script.
 * Scripts do not necessarily have hats.
 */
class IntermediateScript {
    constructor() {
        /**
         * The ID of the top block of this script.
         * @type {string}
         */
        this.topBlockId = null;

        /**
         * List of nodes that make up this script.
         * @type {IntermediateStack[]}
         */
        this.stack = null;

        /**
         * Whether this script is a procedure.
         * @type {boolean}
         */
        this.isProcedure = false;

        /**
         * This procedure's code, if any.
         * @type {string}
         */
        this.procedureCode = '';

        /**
         * List of names of arguments accepted by this function, if it is a procedure.
         * @type {string[]}
         */
        this.arguments = [];

        /**
         * Whether this script should be run in warp mode.
         * @type {boolean}
         */
        this.isWarp = false;

        /**
         * Whether this script can `yield`
         * If false, this script will be compiled as a regular JavaScript function (function)
         * If true, this script will be compiled as a generator function (function*)
         * @type {boolean}
         */
        this.yields = true;

        /**
         * Whether this script should use the "warp timer"
         * @type {boolean}
         */
        this.warpTimer = false;

        /**
         * List of procedure IDs that this script needs.
         * @readonly
         */
        this.dependedProcedures = [];

        /**
         * Cached result of compiling this script.
         * @type {Function|null}
         */
        this.cachedCompileResult = null;

        /**
         * Whether the top block of this script is an executable hat.
         * @type {boolean}
         */
        this.executableHat = false;
    }
}

/**
 * An IntermediateRepresentation contains scripts.
 */
class IntermediateRepresentation {
    constructor() {
        /**
         * The entry point of this IR.
         * @type {IntermediateScript}
         */
        this.entry = null;

        /**
         * Maps procedure variants to their intermediate script.
         * @type {Object.<string, IntermediateScript>}
         */
        this.procedures = {};
    }
}

module.exports = {
    IntermediateStack,
    IntermediateInput,
    IntermediateScript,
    IntermediateRepresentation
};
