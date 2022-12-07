const { IntermediateStack, IntermediateInput, IntermediateScript, IntermediateRepresentation, IntermediateStackBlock } = require('./intermediate');
const { StackOpcode, InputOpcode, InputType } = require('./enums.js')

class TypeState {
    constructor() {
        /** @type {object.<string, InputType>}*/
        this.variables = {};
    }

    clear() {
        let modified = false;
        for (const varId in this.variables) {
            if (this.variables[varId] !== InputType.ANY) {
                modified = true;
                break;
            }
        }
        this.variables = {};
        return modified;
    }

    clone() {
        var clone = new TypeState();
        for (const varId in this.variables) {
            clone.variables[varId] = this.variables[varId];
        }
        return clone;
    }

    setAll(other) {
        this.variables = other.variables;
    }

    or(other) {
        let modified = false;
        for (const varId in other.variables) {
            const currentType = this.variables[varId] ?? InputType.ANY;
            const newType = currentType | other.variables[varId];
            this.variables[varId] = newType;
            modified |= currentType !== newType;
        }
        return modified;
    }

    /**
     * @param {*} variable A variable codegen object.
     * @param {InputType} type The type to set this variable to
     * @returns {boolean}
     */
    setVariableType(variable, type) {
        if (this.getVariableType(variable) === type) return false;
        this.variables[variable.name] = type;
        return true;
    }

    /**
     * 
     * @param {*} variable A variable codegen object.
     * @returns {InputType}
     */
    getVariableType(variable) {
        return this.variables[variable.name] ?? InputType.ANY;
    }
}

class IROptimizer {

    /**
     * @param {IntermediateRepresentation} ir 
     */
    constructor(ir) {
        /** @type {IntermediateRepresentation} */
        this.ir = ir;
    }

    /**
     * @param {IntermediateInput} inputBlock 
     * @param {TypeState} state 
     * @returns {InputType}
     */
    analyzeInputBlock(inputBlock, state) {
        const inputs = inputBlock.inputs;

        switch (inputBlock.opcode) {
            case InputOpcode.VAR_GET:
                return state.getVariableType(inputs.variable);
            case InputOpcode.CAST_NUMBER: {
                const innerType = this.analyzeInputBlock(inputs.target, state);
                if (innerType & InputType.NUMBER) return innerType;
                return InputType.NUMBER;
            }

            case InputOpcode.OP_ADD: {
                const leftType = this.analyzeInputBlock(inputs.left, state);
                const rightType = this.analyzeInputBlock(inputs.right, state);

                let resultType = 0;

                function canBeNaN() {
                    // Infinity + (-Infinity) = NaN
                    if ((leftType & InputType.NUMBER_POS_INF) && (rightType & InputType.NUMBER_NEG_INF)) return true;
                    // (-Infinity) + (Infinity) = NaN
                    if ((leftType & InputType.NUMBER_NEG_INF) && (rightType & InputType.NUMBER_POS_INF)) return true;
                }
                if (canBeNaN()) resultType |= InputType.NUMBER_NAN;

                function canBePos() {
                    if (leftType & InputType.NUMBER_POS) return true; // POS + ANY ~= POS
                    if (rightType & InputType.NUMBER_POS) return true; // ANY + POS ~= POS
                }
                if (canBePos()) resultType |= InputType.NUMBER_POS;

                function canBeNeg() {
                    if (leftType & InputType.NUMBER_NEG) return true; // NEG + ANY ~= NEG
                    if (rightType & InputType.NUMBER_NEG) return true; // ANY + NEG ~= NEG
                }
                if (canBeNeg()) resultType |= InputType.NUMBER_NEG;

                function canBeZero() {
                    // POS_REAL + NEG_REAL ~= 0
                    if ((leftType & InputType.NUMBER_POS_REAL) && (rightType & InputType.NUMBER_NEG_REAL)) return true;
                    // NEG_REAL + POS_REAL ~= 0
                    if ((leftType & InputType.NUMBER_NEG_REAL) && (rightType & InputType.NUMBER_POS_REAL)) return true;
                    // 0 + 0 = 0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_ZERO)) return true;
                    // 0 + -0 = 0
                    if ((leftType & InputType.NUMBER_ZERO) && (rightType & InputType.NUMBER_NEG_ZERO)) return true;
                    // -0 + 0 = 0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_ZERO)) return true;
                }
                if (canBeZero()) resultType |= InputType.NUMBER_ZERO;

                // TDTODO Is this necessary?
                function canBeNegZero() {
                    // -0 + -0 = -0
                    if ((leftType & InputType.NUMBER_NEG_ZERO) && (rightType & InputType.NUMBER_NEG_ZERO)) return true;
                }
                if (canBeNegZero()) resultType |= InputType.NUMBER_NEG_ZERO;

                return resultType;
            }
        }

        return inputBlock.type;
    }

    /**
     * @param {IntermediateStackBlock} stackBlock 
     * @param {TypeState} state 
     * @returns {boolean}
     */
    analyzeStackBlock(stackBlock, state) {
        const inputs = stackBlock.inputs;

        switch (stackBlock.opcode) {
            case StackOpcode.VAR_SET:
                return state.setVariableType(inputs.variable, this.analyzeInputBlock(inputs.value, state));
            case StackOpcode.CONTROL_WHILE:
                return this.analyzeLoopedStack(inputs.do, state, stackBlock);
            case StackOpcode.PROCEDURE_CALL:
                // TDTODO If we've analyzed the procedure we can grab it's type info
                // instead of resetting everything.
                return state.clear();
        }
    }

    /**
     * @param {IntermediateStack} stack 
     * @param {TypeState} state 
     * @returns {boolean}
     */
    analyzeStack(stack, state) {
        if (!stack) return false;
        let modified = false;
        for (const stackBlock of stack.blocks) {
            const stateChanged = this.analyzeStackBlock(stackBlock, state);
            if (stackBlock.yields) state.clear();

            if (stateChanged) {
                if (stackBlock.typeState) stackBlock.typeState.or(state);
                else stackBlock.typeState = state.clone();
                modified = true;
            }
        }
        return modified;
    }

    /**
     * @param {IntermediateStack} stack 
     * @param {TypeState} state 
     * @param {IntermediateStackBlock} block
     * @returns {boolean}
     */
    analyzeLoopedStack(stack, state, block) {
        if (block.yields) {
            state.clear();
            block.entryState = state.clone();
            return this.analyzeStack(stack, state);
        } else {
            let modified = false;
            let keepLooping;
            do {
                const newState = state.clone();
                this.analyzeStack(stack, newState);
                modified |= keepLooping = state.or(newState);
            } while (keepLooping);
            block.entryState = state.clone();
            return modified;
        }
    }

    /**
     * @param {IntermediateInput} input 
     * @param {TypeState} state 
     * @returns {IntermediateInput}
     */
    optimizeInput(input, state) {
        for (const inputKey in input.inputs) {
            const inputInput = input.inputs[inputKey];
            if (inputInput instanceof IntermediateInput)
                input.inputs[inputKey] = this.optimizeInput(inputInput, state);
        }

        switch (input.opcode) {
            case InputOpcode.CAST_NUMBER: {
                const targetType = this.analyzeInputBlock(input.inputs.target, state);
                if ((targetType & InputType.NUMBER) === targetType)
                    return input.inputs.target;
                return input;
            } case InputOpcode.CAST_NUMBER_OR_NAN: {
                const targetType = this.analyzeInputBlock(input.inputs.target, state);
                if ((targetType & InputType.NUMBER_OR_NAN) === targetType)
                    return input.inputs.target;
                return input;
            }
        }

        input.type = this.analyzeInputBlock(input, state);
        return input;
    }

    /**
     * @param {IntermediateStack} stack 
     * @param {TypeState} state 
     */
    optimizeStack(stack, state) {
        if (!stack) return;
        for (const stackBlock of stack.blocks) {
            if (stackBlock.entryState) state = stackBlock.entryState;
            for (const inputKey in stackBlock.inputs) {
                const input = stackBlock.inputs[inputKey];
                if (input instanceof IntermediateInput) {
                    stackBlock.inputs[inputKey] = this.optimizeInput(input, state);
                } else if (input instanceof IntermediateStack) {
                    this.optimizeStack(input, state);
                }
            }
            if (stackBlock.typeState)
                state = stackBlock.typeState;
        }
    }

    optimize() {
        const state = new TypeState();

        for (const procVariant of this.ir.entry.dependedProcedures) {
            this.analyzeStack(this.ir.procedures[procVariant].stack, state);
            this.optimizeStack(this.ir.procedures[procVariant].stack, state);
        }

        this.analyzeStack(this.ir.entry.stack, state);
        this.optimizeStack(this.ir.entry.stack, state);
    }
}


module.exports = IROptimizer;