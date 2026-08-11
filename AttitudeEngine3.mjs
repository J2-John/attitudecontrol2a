// AttiudeEngine3.mjs
// this JavaScript module contains the Attitude Lighting FX engine, version 3
// copyright 2024 Drew Shipps, J Squared Systems


// import
import { SHOWTYPES } from './ShowTypes.js';
import { DIRECTIONS } from './Directions.js';
import { TRANSITIONS } from './Transitions.js';


// configuration options
const RETURN_DATA_ARRAY_LENGTH = 5000;  // # of pixels to use for effect calculations

const MAX_COLORS_COUNT = 25; // Define the maximum count for colors list
const MIN_COLOR_VALUE = 0; // min value for colors 
const MAX_COLOR_VALUE = 255; // max value for colors 

const SPEED_MIN_BPM = 10;
const SPEED_MAX_BPM = 180;

// How long one rendered frame lasts, in milliseconds. This MUST match the interval the
// caller actually renders at - AttitudeFixtureManager's DMX_FRAME_INTERVAL - because every
// show's animation speed is derived from it in updateFramesPerBeat().
//
// It used to be the bare literal 25 inside updateFramesPerBeat(), while the interval that
// really drove the loop lived in a different file. The two agreed only by comment. Changing
// the render rate without also editing that literal would have left every show in the
// library animating at the wrong tempo - a 33ms interval against a hardcoded 25 plays every
// show at 76% speed, fleet-wide, with nothing to indicate why.
//
// Callers should pass their real interval via setFrameInterval(). The default preserves the
// historical value exactly.
const DEFAULT_FRAME_INTERVAL_MS = 25;

const SIZE_MIN = 1;
const SIZE_MAX = 200;

const SPLITS_MIN = 1;
const SPLITS_MAX = 10;

const TRANSITION_WIDTH_MIN = 0;
const TRANSITION_WIDTH_MAX = 1;


// Attitude Engine version 3 class definition
class AttitudeEngine3 {

    // constructor with parameters argument (req. all params to be present)
    constructor(params) {
        this.config = {};

        // frame duration must be known before updateFramesPerBeat() runs below
        this.frameIntervalMs = DEFAULT_FRAME_INTERVAL_MS;

        this.validateRequiredParams(params); // Ensure all required parameters are present
        this.setParams(params); // Initialize configuration with provided parameters

        // intialize the counter variables
        this.beatCounter = 1;  // counts 1 -> max # of color steps
        this.frameCounter = 1;  // counts 1 -> max # of frames per beat

        // update # of frames per beat
        this.updateFramesPerBeat();

        // initialize pixel data
        this.pixelData = [];

        // initialize reverse option
        this.isInReverse = false;

        // initialize randomness seed
        this.randomnessSeed = this.generateRandomNumberSeed(RETURN_DATA_ARRAY_LENGTH, RETURN_DATA_ARRAY_LENGTH);
        // console.log(this.randomnessSeed);

        // ---- base cache (perf, 2026-08) ----
        // The colour base is a pure function of the show's configuration: colours,
        // transition, transition width, size and show type. It does NOT depend on
        // beatCounter or frameCounter. It was previously rebuilt from scratch on every
        // frame, which was the single largest cost in the render loop. It is now built
        // once per configuration and reused until the configuration actually changes.
        // Nothing downstream mutates the array in place - every stage reassigns
        // this.pixelData to a new array - so handing out the cached array is safe.
        this._baseSig = null;
        this._baseData = null;
        this._baseScalars = null;

        // ---- fixture split cache (perf, 2026-08) ----
        // getFixtureColor() rebuilt the decimated fixture array on every single call,
        // and the fixture manager calls it once per segment per frame. pixelData cannot
        // change between run() calls, so the split is computed at most once per frame.
        this._splitCache = null;
        this._splitCacheCount = -1;
    }

    // configure the engine with certain parameters. note that this function does not require all parameters to be present
    configure(params) {
        this.setParams(params); // Update configuration with new parameters

        // if the speed exists in this parameter list, it could have changed. thus, let's update the # of frames per beat
        if (params.speed !== undefined) {
            // update # of frames per beat
            this.updateFramesPerBeat();
        }
    }

    // validate a set of parameters, then set them to the this.config variable
    setParams(params) {
        this.validateParams(params); // Validate the parameters
        Object.assign(this.config, params); // Merge the parameters into the configuration
    }

    // tell the engine how long one rendered frame lasts, so animation speed tracks the
    // caller's real render interval instead of an assumed one. Safe to call at any time.
    setFrameInterval(intervalMs) {
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            throw new Error(`Invalid frame interval. Expected a positive number of milliseconds, but got ${intervalMs}.`);
        }

        this.frameIntervalMs = intervalMs;

        // framesPerBeat is derived from it, so it has to be recomputed
        this.updateFramesPerBeat();
    }

    // set the number of fixtures to emulate for grabbing fixture values
    setFixtureCount(fixtureCount) {
        if (!Number.isInteger(fixtureCount) || fixtureCount < 0 || fixtureCount > RETURN_DATA_ARRAY_LENGTH) {
            throw new Error(`Invalid fixture count. Fixture count must be an integer between 0 and ${RETURN_DATA_ARRAY_LENGTH}.`);
        } else {
            if (this.fixtureCount !== fixtureCount) {
                this._splitCache = null;
                this._splitCacheCount = -1;
            }
            this.fixtureCount = fixtureCount;
        }
    }

    // get fixture color (requres fixtureCount to have been set)
    getFixtureColor(index = null) {
        // validate index value
        if (index != null && (index < 0 || index >= this.fixtureCount || !Number.isInteger(index))) {
            throw new Error(`Invalid index requested. Expected between 0 and ${this.fixtureCount}, but got ${index}`);
        }

        // validate fixtureCount valid
        if (this.fixtureCount != null && (this.fixtureCount < 0 || this.fixtureCount > RETURN_DATA_ARRAY_LENGTH || !Number.isInteger(this.fixtureCount))) {
            throw new Error(`Fixture count must be set to a valid integer before calling getFixtureColor. 
                Expected between 0 and ${RETURN_DATA_ARRAY_LENGTH}, but got ${fixtureCount}`);
        }

        // evenly split the array by the number of fixtures.
        // memoised for the current frame - see _splitCache note in the constructor.
        var fixtureColors = this._splitCache;
        if (fixtureColors === null || this._splitCacheCount !== this.fixtureCount) {
            fixtureColors = this.splitArrayIntoNumberOfItems(this.pixelData, this.fixtureCount);
            this._splitCache = fixtureColors;
            this._splitCacheCount = this.fixtureCount;
        }

        // console.log('INDEX IS ' + index + ' and FIXTURECOLORS length is ' + fixtureColors.length + ' and FIXTURE COUNT is ' + this.fixtureCount);

        // now grab whatever index is asked for (if null then all)
        if (index == null) {
            return fixtureColors;
        } else {
            return fixtureColors[index];
        }
    }


    // validate that the required parameters are present
    validateRequiredParams(params) {
        const requiredParams = ['showType', 'direction', 'speed', 'size', 'splits', 'transitionWidth', 'bounce', 'colors'];
        requiredParams.forEach(param => {
            if (params[param] === undefined) {
                throw new Error(`Missing required parameter: ${param}`);
            }
        });
    }

    // validate all present parameters
    validateParams(params) {
        if (params.showType !== undefined) {
            this.validateShowType(params.showType);
        }
        if (params.direction !== undefined) {
            this.validateDirection(params.direction);
        }
        if (params.speed !== undefined) {
            this.validateSpeed(params.speed);
        }
        if (params.size !== undefined) {
            this.validateSize(params.size);
        }
        if (params.splits !== undefined) {
            this.validateSplits(params.splits);
        }
        if (params.transition !== undefined) {
            this.validateTransition(params.transition);
        }
        if (params.transitionWidth !== undefined) {
            this.validateTransitionWidth(params.transitionWidth);
        }
        if (params.bounce !== undefined) {
            this.validateBounce(params.bounce);
        }
        if (params.colors !== undefined) {
            this.validateColors(params.colors);
        }
    }


    // validation logic for each parameter

    validateShowType(showType) {
        if (!Object.values(SHOWTYPES).includes(showType)) {
            throw new Error(`Invalid showType: ${showType}`);
        }
    }

    validateDirection(direction) {
        if (!Object.values(DIRECTIONS).includes(direction)) {
            throw new Error(`Invalid direction: ${direction}`);
        }
    }

    validateSpeed(speed) {
        if (!Number.isInteger(speed) || speed < SPEED_MIN_BPM || speed > SPEED_MAX_BPM) {
            throw new Error(`Invalid speed. Speed must be an integer between ${SPEED_MIN_BPM} and ${SPEED_MAX_BPM}.`);
        }
    }

    validateSize(size) {
        if (!Number.isInteger(size) || size < SIZE_MIN || size > SIZE_MAX) {
            throw new Error(`Invalid size. Size must be an integer between ${SIZE_MIN} and ${SIZE_MAX}.`);
        }
    }

    validateSplits(splits) {
        if (!Number.isInteger(splits) || splits < SPLITS_MIN || splits > SPLITS_MAX) {
            throw new Error(`Invalid splits. Splits must be an integer between ${SPLITS_MIN} and ${SPLITS_MAX}.`);
        }
    }

    validateTransition(transition) {
        if (!Object.values(TRANSITIONS).includes(transition)) {
            throw new Error(`Invalid transition: ${transition}`);
        }
    }

    validateTransitionWidth(transitionWidth) {
        if (!(!isNaN(parseFloat(transitionWidth)) && isFinite(transitionWidth)) || transitionWidth < TRANSITION_WIDTH_MIN || transitionWidth > TRANSITION_WIDTH_MAX) {
            throw new Error(`Invalid transition width. Transition width must be an integer between ${TRANSITION_WIDTH_MIN} and ${TRANSITION_WIDTH_MAX}.`);
        }
    }

    validateBounce(bounce) {
        if (typeof bounce !== 'boolean') {
            throw new Error('Invalid bounce. Bounce must be a boolean.');
        }
    }

    validateColors(colors) {
        if (!Array.isArray(colors)) {
            throw new Error('Colors must be an array');
        }
        if (colors.length === 0 || colors.length > MAX_COLORS_COUNT) {
            throw new Error(`Colors must contain between 1 and ${MAX_COLORS_COUNT} colors`);
        }
        colors.forEach(color => {
            if (!Number.isInteger(color.red) || color.red < MIN_COLOR_VALUE || color.red > MAX_COLOR_VALUE ||
                !Number.isInteger(color.green) || color.green < MIN_COLOR_VALUE || color.green > MAX_COLOR_VALUE ||
                !Number.isInteger(color.blue) || color.blue < MIN_COLOR_VALUE || color.blue > MAX_COLOR_VALUE) {
                throw new Error('Each color object must have red, green, and blue values as integers between 0 and 255');
            }
        });
    }


    // method to run engine color calculations
    run() {
        this.incrementFrameCounter();

        // pixelData is about to be rebuilt, so last frame's fixture split is stale
        this._splitCache = null;

        try {
            switch (this.config.showType) {
                case SHOWTYPES.STATIC:
                    return this.calculateStaticEffect();
                case SHOWTYPES.ALL:
                    return this.calculateAllEffect();
                case SHOWTYPES.CHASE:
                    return this.calculateChaseEffect();
                case SHOWTYPES.PULSE:
                    return this.calculatePulseEffect();
                default:
                    throw new Error(`Invalid showType: ${this.config.showType}`);
            }
        } catch (error) {
            console.error('Error calculating color values:', error);
            return { red: 0, green: 0, blue: 0 }; // Fallback color
        }
    }


    // Effect calculation methods

    // build a signature of every configuration value the colour base depends on.
    // beatCounter/frameCounter are deliberately absent - the base is frame independent.
    baseSignature() {
        const c = this.config;
        const colors = c.colors;
        let sig = c.showType + '|' + c.transition + '|' + c.transitionWidth + '|' + c.size + '|' + colors.length;
        for (let i = 0; i < colors.length; i++) {
            const col = colors[i];
            sig += '|' + col.red + ',' + col.green + ',' + col.blue;
        }
        return sig;
    }

    // prepare the colour base for this frame, from cache when the configuration is unchanged.
    // builder is the function that constructs the base; flip says whether this effect flips it.
    prepareBase(builder, flip) {
        const sig = this.baseSignature();

        if (this._baseSig === sig && this._baseData !== null) {
            // cache hit - restore the derived scalars the later stages read, then reuse the array
            const s = this._baseScalars;
            this.pixelsPerColor = s.pixelsPerColor;
            this.pixelsToFadePerColor = s.pixelsToFadePerColor;
            this.staticPixelsPerColor = s.staticPixelsPerColor;
            this.lengthOfColorPulseSegment = s.lengthOfColorPulseSegment;
            this.basePixels = s.basePixels;
            this.pixelData = this._baseData;
            return;
        }

        // cache miss - build it, flip it if this effect flips, and store the result
        builder.call(this);
        if (flip) {
            this.flipPixelData();
        }

        this._baseSig = sig;
        this._baseData = this.pixelData;
        this._baseScalars = {
            pixelsPerColor: this.pixelsPerColor,
            pixelsToFadePerColor: this.pixelsToFadePerColor,
            staticPixelsPerColor: this.staticPixelsPerColor,
            lengthOfColorPulseSegment: this.lengthOfColorPulseSegment,
            basePixels: this.basePixels,
        };
    }

    // calculate the color base for all effects
    calculateColorBase() {
        // clear out pixelData variable
        this.pixelData = [];

        // Determine the number of pixels per color section based exclusively on color count
        // size is processed later on in the system
        this.pixelsPerColor = Math.ceil(RETURN_DATA_ARRAY_LENGTH / this.config.colors.length);

        // determine number of pixels to fade per color
        this.pixelsToFadePerColor = Math.round(this.pixelsPerColor * this.config.transitionWidth);

        // determine pixels static per color
        this.staticPixelsPerColor = this.pixelsPerColor - this.pixelsToFadePerColor;

        // Iterate over each color in the colors list
        for (let i = 0; i < this.config.colors.length; i++) {
            // calculate color indexes
            var currentColorIndex = i;
            var nextColorIndex = (i + 1) % this.config.colors.length;
            
            // add static pixels for this color
            for (let p = 0; p < this.staticPixelsPerColor; p++) {
                this.pixelData.push(this.config.colors[currentColorIndex]);
            }

            // if this is the leading edge AND we are doing leading transitions, OR we are doing both, then fade
            if (this.config.transition == TRANSITIONS.BOTH
                 || (this.config.transition == TRANSITIONS.LEADING && (i % 2 == 1 || i == this.config.colors.length - 1))
                 || (this.config.transition == TRANSITIONS.TRAILING && (i % 2 == 0 && i != this.config.colors.length - 1))) {
                for (let p = 0; p < this.pixelsToFadePerColor; p++) {
                    this.pixelData.push(this.masterFadeFunction(currentColorIndex, nextColorIndex, this.pixelsToFadePerColor, p));
                }
            } else {
                for (let p = 0; p < this.pixelsToFadePerColor; p++) {
                    this.pixelData.push(this.config.colors[currentColorIndex]);
                }
            }
        }
    }


    // play the chase effect color base on the pixels, statically. repeat to fill pixels if needed.
    calculateStaticEffect() {
        // calculate the color base (cached; static does not flip)
        this.prepareBase(this.calculateColorBase, false);

        // expand length to 1000 (loop if necesary), or trim to 1000
        this.expandOrTrimPixelDataLength();

        // process the directions layer
        this.processDirections();

        // process the splits layer
        this.processSplits();

        // validate that the resulting length is long enough (or trim if too long)
        this.validatePixelDataLength();
    }


    // all fade takes all fixtures and makes them the same color, then fades through each color in colors list
    calculateAllEffect() {
        // calculate the color base and flip it (both cached - see prepareBase)
        this.prepareBase(this.calculateColorBase, true);

        // circulate array to animate it
        this.processCirculation();

        // process splits for all:
        // create a list of colors that should be used on each long segment of all one color
        // by calculating how many pixels per segment using the splits value
        var splitsOnAllColorsList = [];
        var pixelsPerSplit = Math.round(RETURN_DATA_ARRAY_LENGTH / this.config.splits);
        for (var i = 0; i < this.config.splits; i++) {
            splitsOnAllColorsList[i] = this.pixelData[pixelsPerSplit * i];
        }

        // clear the array
        this.pixelData = [];

        // update all pixels to this color
        for (let i = 0; i < RETURN_DATA_ARRAY_LENGTH; i++) {
            // based on this pixel, grab the index of the color to use from the above array then push it
            var colorIndex = Math.floor(i / pixelsPerSplit);
            this.pixelData.push(splitsOnAllColorsList[colorIndex]);
        }

        // validate length, ensure is = 1000 (or trim if too long)
        this.validatePixelDataLength();
    }


    // chase effect animates the color base across the pixels
    calculateChaseEffect() {
        // calculate the color base and flip it (both cached - see prepareBase)
        this.prepareBase(this.calculateColorBase, true);

        // circulate array to animate it
        this.processCirculation();

        // now process size to scale circulated array as needed
        this.processSize();

        // expand length to 1000 (loop if necesary), or trim to 1000
        this.expandOrTrimPixelDataLength();

        // process the directions layer
        this.processDirections();

        // process the splits layer
        this.processSplits();

        // validate that the resulting length is long enough (or trim if too long)
        this.validatePixelDataLength();
    }


    // pulse effect
    calculatePulseEffect() {
        // calculate the pulse base and flip it (both cached - see prepareBase)
        this.prepareBase(this.calculatePulseBase, true);

        // circulate array to animate it
        this.processCirculation();

        // expand length to 1000 (loop if necesary), or trim to 1000
        this.expandOrTrimPixelDataLength();

        // process the directions layer
        this.processDirections();

        // process the splits layer
        this.processSplits();

        // validate that the resulting length is long enough (or trim if too long)
        this.validatePixelDataLength();
    }


    // build the colour base for the pulse effect (configuration dependent only)
    calculatePulseBase() {
        // clear out pixelData variable
        this.pixelData = [];

        // A pulse is a base colour with the remaining colours travelling through it, so
        // it needs at least two colours. With exactly one colour the loop below produced
        // an empty array, and expandPixelDataLength() then spun forever trying to grow
        // an empty array to length - a hard hang of the render thread, not a catchable
        // error. Fixed 2026-08-10. One colour now renders as that solid colour.
        if (this.config.colors.length < 2) {
            this.pixelsPerColor = RETURN_DATA_ARRAY_LENGTH;
            this.lengthOfColorPulseSegment = RETURN_DATA_ARRAY_LENGTH;
            this.pixelsToFadePerColor = 0;
            this.staticPixelsPerColor = RETURN_DATA_ARRAY_LENGTH;
            this.basePixels = RETURN_DATA_ARRAY_LENGTH;

            const only = this.config.colors[0];
            for (let p = 0; p < RETURN_DATA_ARRAY_LENGTH; p++) {
                this.pixelData.push(only);
            }
            return;
        }

        // Determine the number of pixels per color section
        // use ceiling function to ensure no leftovers
        var percentageOfTotalPixelsPerColor = 100 / this.config.size;
        this.lengthOfColorPulseSegment = Math.ceil(RETURN_DATA_ARRAY_LENGTH / percentageOfTotalPixelsPerColor);
        
        // pixelsPerColor is total including base color buffer at end for pulse effect
        // use this.lengthOfColorPulseSegment for usual pixelsPerColor
        this.pixelsPerColor = this.lengthOfColorPulseSegment + RETURN_DATA_ARRAY_LENGTH;


        // determine number of pixels to fade per color (use lengthOfColorPulseSegment)
        this.pixelsToFadePerColor = Math.round(this.lengthOfColorPulseSegment * this.config.transitionWidth);
        
        // if we are transitioning on both sides, we need to add a bit to the total to account for the extra fade
        // accounts for the weird splits bug discovered 6/9/24
        
        // if (this.config.transition == TRANSITIONS.BOTH) {
        //     this.pixelsPerColor += this.pixelsToFadePerColor;
        // }

        // determine pixels static per color
        this.staticPixelsPerColor = this.lengthOfColorPulseSegment - this.pixelsToFadePerColor;

        if (this.config.transition == TRANSITIONS.BOTH) {
            this.staticPixelsPerColor -= this.pixelsToFadePerColor;
        }

        // determine base color pixel count
        this.basePixels = RETURN_DATA_ARRAY_LENGTH;

        // Iterate over each color in the colors list
        for (let i = 1; i < this.config.colors.length; i++) {

            // leading edge: if we are transitioning both sides, then push fade pixels
            if (this.config.transition == TRANSITIONS.BOTH) {
                for (let p = 0; p < this.pixelsToFadePerColor; p++) {
                    this.pixelData.push(this.masterFadeFunction(0, i, this.pixelsToFadePerColor, p));
                }
            }

            // middle segment: set to length of static (segment color) pixels
            for (let p = 0; p < this.staticPixelsPerColor; p++) {
                this.pixelData.push(this.config.colors[i]);
            }

            // trailing edge: if we are transitioning both sides, then push fade pixels
            if (this.config.transition == TRANSITIONS.BOTH || this.config.transition == TRANSITIONS.TRAILING) {
                for (let p = 0; p < this.pixelsToFadePerColor; p++) {
                    this.pixelData.push(this.masterFadeFunction(i, 0, this.pixelsToFadePerColor, p));
                }
            }

            // base pixels: insert enough pixels as a base to cover the entire rest of the pixels after the tail
            for (let p = 0; p < this.basePixels; p++) {
                this.pixelData.push(this.config.colors[0]);
            }
        }




    }



    // timing methods

    // increment beat counter - i think this should be called somewhere by the parent to syncronize all engines together
    incrementBeatCounter() {
        // if in bounce mode
        if (this.config.bounce) {
            // check if reverse or not
            if (!this.isInReverse) {
                // increase beat counter if forwards
                this.beatCounter++;

                // reset frame counter to 1 if going forwards
                this.frameCounter = 1;
            } else {
                // increase beat counter if forwards
                this.beatCounter--;

                // reset frame counter to 1 if going forwards
                this.frameCounter = this.framesPerBeat;
            }

            // if we've looped over all colors, set to reverse
            if (this.beatCounter > this.config.colors.length) {
                this.isInReverse = true;
            }

            // if we've hit zero again, set reverse to false
            if (this.beatCounter < 1) {
                this.isInReverse = false;
            }

            // console.log(`BOUNCE MODE beatCounter updated to ${this.beatCounter} and frameCounter reset to 1`);
        } else {
            // increment beat counter
            this.beatCounter++;

            // if we've looped over all colors, reset to 1
            if (this.beatCounter > this.config.colors.length) {
                this.beatCounter = 1;
            }

            // reset frame counter
            this.frameCounter = 1;

            // ensure we are set to forward mode
            this.isInReverse = false;

            // log each time the beat counter is increased
            // console.log(`beatCounter update to ${this.beatCounter} and frameCounter reset to 1`);
        }
    }

    // increment frame counter - called every time engine.run() is called to calculate effects
    incrementFrameCounter() {
        // check if we are in reverse due to bounce mode
        if (this.isInReverse) {
            // move backward frames
            this.frameCounter--;

            // if minimumed out
            if (this.frameCounter < 1) {
                // increment the beat counter to go to the next beat
                this.incrementBeatCounter();

                // log each time the frame counter rolls over
                // console.log(`NEGATIVE ROLLOVER frameCounter is at ${this.frameCounter}, which is > than framesPerBeat ${this.framesPerBeat}`);
            }
        } else {
            // move forward frames
            this.frameCounter++;

            // if maxed out
            if (this.frameCounter > this.framesPerBeat) {
                // increment the beat counter to go to the next beat
                // when it comes time to sycnronize effects or provide more accurate beat-synced effects,
                // this will need to be removed and synced across effects at the master level
                this.incrementBeatCounter();

                // log each time the frame counter rolls over
                // console.log(`frameCounter is at ${this.frameCounter}, which is > than framesPerBeat ${this.framesPerBeat}`);
            }
        }
    }

    // restart beat counter - this will start the effect from scratch and can be used to syncronize with other FX
    restartBeatCounter() {
        // reset beats and frames
        this.beatCounter = 1;
        this.frameCounter = 1;
    }


    // update frames per beat (does not reset any counter variables)
    updateFramesPerBeat() {
        // # of __ per ___
        this.beatsPerSecond = this.config.speed / 60;  // bpm (speed) / 60 sec/min. can't round bc <1 beat per second rounded to 0
        this.msPerBeat = 1000 / this.beatsPerSecond;  // # of milliseconds per beat
        this.framesPerBeat = Math.round(this.msPerBeat / this.frameIntervalMs);  // msPerBeat / msPerFrame = frames per beat

        // calculate the diff and log these variables
        // var diff = (this.msPerBeat - (this.framesPerBeat * 25)); // diff between expected MS per beat and REAL ms per beat using 25ms interval
        // console.log(`Frames per beat updated to ${this.framesPerBeat} bc bpm was ${this.config.speed} (diff of ${diff})`);
    }


    // trim the pixel data length to the proper length
    trimPixelDataLength() {
        this.pixelData = this.pixelData.slice(0, RETURN_DATA_ARRAY_LENGTH);
    }

    // expand the pixel data length to the proper length, looping until 1000 is reached
    expandPixelDataLength() {
        const source = this.pixelData;
        const sourceLength = source.length;

        // An empty source can never reach the target length, so the old while loop
        // spun forever with no way out - the render thread hung and the device went
        // dark with nothing logged. Guard it: throwing is caught by run(), which falls
        // back to black and reports the error. Reachable via a 1-colour Pulse show,
        // which is also fixed at source in calculatePulseBase(). 2026-08-10.
        if (sourceLength === 0) {
            throw new Error('Cannot expand an empty pixelData array to length ' + RETURN_DATA_ARRAY_LENGTH);
        }

        // Build without push(...source). The spread passed one argument per pixel, so a
        // large intermediate array (a Pulse show with many colours at a large size builds
        // hundreds of thousands of pixels) exceeded the JS argument limit and threw
        // RangeError, which run() swallowed - the show silently rendered as the fallback
        // colour. 2026-08-10.
        //
        // Construction style matters as much as the algorithm here. `new Array(n)` plus
        // indexed writes produces a HOLEY array, and V8 checks for holes on every read for
        // the life of that array. On the A53 that cost is paid by every downstream stage and
        // it measured worse on device than the code it replaced, despite looking faster on
        // x86. slice() and push() keep the array PACKED. Verified with %HasHoleyElements.
        // Do not "optimise" this back into new Array(n) + index assignment.
        if (sourceLength >= RETURN_DATA_ARRAY_LENGTH) {
            this.pixelData = source.slice(0, RETURN_DATA_ARRAY_LENGTH);
            return;
        }

        const resultArray = source.slice();
        while (resultArray.length + sourceLength <= RETURN_DATA_ARRAY_LENGTH) {
            pushAllChunked(resultArray, source);
        }
        if (resultArray.length < RETURN_DATA_ARRAY_LENGTH) {
            pushAllChunked(resultArray, source.slice(0, RETURN_DATA_ARRAY_LENGTH - resultArray.length));
        }

        this.pixelData = resultArray;
    }

    // expand to 1000 (loop if necesary) or trim to 1000
    expandOrTrimPixelDataLength() {
        // expandPixelDataLength() now always produces exactly RETURN_DATA_ARRAY_LENGTH
        // items, so the trim that used to follow it was a full array copy that changed
        // nothing. trimPixelDataLength() is retained for callers that need it.
        this.expandPixelDataLength();
    }

    // validate that the pixel data array is the proper length (and still trim it down in case it's too long)
    validatePixelDataLength() {
        if (this.pixelData.length < RETURN_DATA_ARRAY_LENGTH) {
            throw new Error(`Invalid this.pixelData length (too short). Expected ${RETURN_DATA_ARRAY_LENGTH}, but got ${this.pixelData.length}.`);
        } else if (this.pixelData.length > RETURN_DATA_ARRAY_LENGTH) {
            // only copy when there is something to trim - the common case is already
            // exactly the right length, where the slice was a wasted full copy
            this.pixelData = this.pixelData.slice(0, RETURN_DATA_ARRAY_LENGTH);
        }
    }


    // flip the pixelData array
    flipPixelData() {
        this.pixelData = this.pixelData.slice().reverse();
    }


    // circulate the pixelData array to animate it
    processCirculation() {
        const pixelsPerFrame = this.pixelsPerColor / this.framesPerBeat;
        const distanceToCirculate = Math.round(pixelsPerFrame * this.frameCounter + this.pixelsPerColor * (this.beatCounter - 1));
        this.pixelData = this.circulateArray(this.pixelData, distanceToCirculate);
    }


    // process the size parameter and stretch the array accordingly
    processSize() {
        // calculate the percent of total pixels per color (using size)
        var percentageOfTotalPixelsPerColor = 100 / this.config.size;

        // calculate the # of pixels to zoom in on
        var numberOfPixelsToZoomInOn = Math.round(this.pixelsPerColor * percentageOfTotalPixelsPerColor);

        // slice those pixels out of the pixelData array
        var pixelsFromZoom = this.pixelData.slice(0, numberOfPixelsToZoomInOn);

        // stretch the array to fit the total return data array length
        this.pixelData = this.stretchArray(pixelsFromZoom, RETURN_DATA_ARRAY_LENGTH);
    }


    // process directions
    processDirections() {
        switch (this.config.direction) {
            case DIRECTIONS.LR:
                // for left to right, the array does not need to change at all
                break;
            case DIRECTIONS.RL:
                // for right to left, simply flip the output array
                this.pixelData = this.pixelData.slice().reverse();
                break;
            case DIRECTIONS.MID_END:
                // Handle mid to ends direction

                // grab every other item in the array
                var everyOtherItem = [];
                for (var i = 0; i < this.pixelData.length; i+=2) {
                    everyOtherItem.push(this.pixelData[i]);
                }

                // now use this as the right half and flip it for left half
                var newFinalArray = [];
                var reverse = everyOtherItem.slice().reverse();

                // push the reverse, then forward
                newFinalArray.push(...reverse);
                newFinalArray.push(...everyOtherItem);

                // now set to pixeldata
                this.pixelData = newFinalArray;

                break;
            case DIRECTIONS.END_MID:
                // Handle ends to middle direction

                // grab every other item in the array
                var everyOtherItem = [];
                for (var i = 0; i < this.pixelData.length; i+=2) {
                    everyOtherItem.push(this.pixelData[i]);
                }

                // now use this as the right half and flip it for left half
                var newFinalArray = [];
                var reverse = everyOtherItem.slice().reverse();

                // push the forward, then the reverse, for ends to middle
                newFinalArray.push(...everyOtherItem);
                newFinalArray.push(...reverse);

                // now set to pixeldata
                this.pixelData = newFinalArray;

                break;
            case DIRECTIONS.RANDOM:
                // Handle random direction

                // create a new array with the random order of pixelData
                var shuffledPixelDataArray = [];
                for (var i = 0; i < RETURN_DATA_ARRAY_LENGTH; i++) {
                    // console.log(this.randomnessSeed[i]);
                    shuffledPixelDataArray[i] = this.pixelData[this.randomnessSeed[i]];
                }
                    // console.log('this.pixelData');

                this.pixelData = shuffledPixelDataArray;

                break;
            default:
                throw new Error(`Invalid direction ${this.config.direction}`);
        }
    }


    // process splits
    processSplits() {
        // split the pixelData array by the number of splits (ex. for 2 splits, grab every other fixture)
        this.pixelData = this.splitArrayByNumberOfItems(this.pixelData, this.config.splits);

        // CREATE A FADE ON THE EDGE OF EACH SPLIT
        // this party is kinda iffy on how well it works
        /*
        this.pixelsToFadePerSplit = Math.round(this.pixelsToFadePerColor / this.config.splits);

        var startPixelToFade = this.pixelData.length - this.pixelsToFadePerSplit;
        var endPixelToFade = this.pixelData.length;

        var startPixelColor = this.pixelData[startPixelToFade - 1];
        var endPixelColor = this.pixelData[0];

        // console.log('startPixelToFade ' + startPixelToFade + ' endPixelToFade ' + endPixelToFade);
            // console.log(this.pixelsToFadePerSplit);

            // console.log('startPixelColor');
            // console.log(startPixelColor);
            // console.log('endPixelColor');
            // console.log(endPixelColor);
            // console.log('startPixelToFade');
            // console.log(startPixelToFade);
            // console.log('endPixelToFade');
            // console.log(endPixelToFade);
            // console.log('this.pixelsToFadePerColor');
            // console.log(this.pixelsToFadePerColor);
            // console.log('');

        for (var p = startPixelToFade; p < endPixelToFade; p++) {
            var fadeIndex = p - startPixelToFade;
            this.pixelData[p] = this.fadeBetweenColorObjects(startPixelColor, endPixelColor, this.pixelsToFadePerSplit, fadeIndex);
        }

        // console.log(this.pixelsToFadePerColor);
*/

        // expand length to 1000 (loop if necesary), or trim to 1000
        this.expandOrTrimPixelDataLength();
    }





    // UTILITY FUNCTIONS

    // circulate any array by a number of positions
    circulateArray(arr, positions) {
        // Ensure positions is a positive integer
        const len = arr.length;
        const shift = positions % len; // This handles cases where positions > len

        // Create a new array with the circulated elements.
        // This briefly used `new Array(len)` plus indexed writes to save two allocations.
        // That produces a HOLEY array, which V8 then hole-checks on every subsequent read,
        // and it measured slower on the A53 even though it looked faster on x86. slice()
        // and concat() both return PACKED arrays and the allocations are cheaper than the
        // hole checks. Reverted 2026-08-10 - see the note in expandPixelDataLength().
        const circulated = arr.slice(-shift).concat(arr.slice(0, -shift));
        return circulated;
    }


    // stretch an array from its original length to the newSize parameter
    stretchArray(originalArray, newSize) {
        const originalSize = originalArray.length;

        // push into an empty array rather than filling a `new Array(newSize)`. Same values
        // in the same order, but PACKED instead of HOLEY - see expandPixelDataLength().
        // This one predates 2026-08 and was holey on shipped 2.A.4 as well.
        const stretchedArray = [];

        // Calculate the step size for even distribution
        const step = originalSize / newSize;

        for (let i = 0; i < newSize; i++) {
            // Calculate the corresponding position in the original array
            const pos = Math.floor(i * step);
            stretchedArray.push(originalArray[pos]);
        }

        return stretchedArray;
    }


    // split the array by x number of items (ex. split by 2 into halves, split by 3 into thirds)
    splitArrayByNumberOfItems(array, items) {
        // the # of items that should result from this array
        const resultingItemsLength = Math.round(array.length / items);

        // Calculate the number of items to skip per section
        const skipPerSection = Math.round(array.length / resultingItemsLength);

        // Initialize an array to store the first items of each section
        const firstItems = [];

        // Iterate over the array, skipping items as needed
        for (let i = 0; i < array.length; i += skipPerSection) {
            firstItems.push(array[i]);
        }

        // return new array
        return firstItems;
    }

    // pull an even distribution of the items out of an array (ie. grab 100 fixtures out of 1000, evenly distributed)
    splitArrayIntoNumberOfItems(array, items) {
        // Calculate the number of items to skip per section
        const skipPerSection = Math.floor(array.length / items);

        // Initialize an array to store the first items of each section
        const firstItems = [];

        // Iterate over the array, skipping items as needed
        for (let i = 0; i < array.length; i += skipPerSection) {
            firstItems.push(array[i]);
        }

        // return new array
        return firstItems;
    }

    // generate a random string (used for the random direction option)
    generateRandomNumberSeed(size, max) {
        if (size > max + 1) {
            throw new Error('Size cannot be greater than the range of unique numbers.');
        }

        // Create an array containing numbers from 0 to max
        const numbers = Array.from({ length: max + 1 }, (_, i) => i);

        // Fisher-Yates shuffle
        for (let i = numbers.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
        }

        // Return the first 'size' elements from the shuffled array
        return numbers.slice(0, size);
    }


    // master fade function between two color indexes
    masterFadeFunction(currentColorIndex, nextColorIndex, steps, currentStep) {
        // a future idea is to add logic here to offer different fade curve options
        return this.fadeBetweenColorObjects(this.config.colors[currentColorIndex], this.config.colors[nextColorIndex], steps, currentStep);
    }

    // fade between two color objects
    fadeBetweenColorObjects(colorObject1, colorObject2, steps, currentStep) {
        // we've been having issues with the fade curve for a while with unique colors
        // such as non-primary colors. apparently, the fix is just to use the linear fade func
        var red = fadeFunc(colorObject1.red, colorObject2.red, steps, currentStep);
        var green = fadeFunc(colorObject1.green, colorObject2.green, steps, currentStep);
        var blue = fadeFunc(colorObject1.blue, colorObject2.blue, steps, currentStep);

        return {
            red: red,
            green: green,
            blue: blue,
        }
    }
}


// export the engine class
export { AttitudeEngine3 };



// UTILITY FUNCTIONS

// Append every item of `items` onto `target` in bounded chunks.
// push.apply is a bulk append, but it passes one argument per element, and past roughly
// 125,000 arguments that throws RangeError - which is how a large Pulse show used to fail
// silently. Chunking keeps the argument count bounded whatever the source size, while
// keeping `target` PACKED (a plain indexed fill would make it HOLEY and slow every later
// read on the A53).
function pushAllChunked(target, items) {
    const CHUNK = 4096;
    const total = items.length;
    for (let i = 0; i < total; i += CHUNK) {
        target.push.apply(target, items.slice(i, Math.min(i + CHUNK, total)));
    }
}

function fadeFunc(color1, color2, steps, currentStep) {
    return Math.round(color2 / steps * currentStep + color1 / steps * (steps - currentStep));
}

function sineFadeFunc(color1, color2, steps, currentStep) {
    var val = Math.round(color2 / steps * currentStep + color1 / steps * (steps - currentStep));
    var radiansPer8BitStep = (Math.PI/2) / 255;
    var sinVal = Math.sin(radiansPer8BitStep*val);
    var result = Math.round(sinVal * 255);

    return result;
}

function sineFadeFuncAlt(color1, color2, steps, currentStep) {
    var val = Math.round(color2 / steps * currentStep + color1 / steps * (steps - currentStep));

    var divisor = (color1 == 0 && color2 == 0) ? 255 : val;
    var radiansPer8BitStep = (Math.PI/2) / divisor;
    var sinVal = Math.sin(radiansPer8BitStep*val);
    var result = Math.round(sinVal * divisor);

    return result;
}

function saturatedFadeFunc(color1, color2, steps, currentStep) {
    var halfSteps = steps / 2;

    var color2Val = Math.round(Math.min((color2 / halfSteps) * currentStep, 255));
    var color1Val = Math.round(Math.min((color1 / halfSteps) * (steps - currentStep), 255));

    var result = color2Val + color1Val;

    return result;
}






