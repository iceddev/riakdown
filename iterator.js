var util = require('util');
var async = require('async');
var Transform = require('stream').Transform;
var AbstractIterator = require('abstract-leveldown').AbstractIterator;

function mapValues(value, key) {
    if (value.values[0].metadata['X-Riak-Deleted']) return [];
    return [{ key: value.key, value: value.values[0].data }];
}

function sort(values, reverse) {
    return values.sort(function (a, b) {
        if (a.key < b.key) {
            return reverse ? 1 : -1;
        } else if (a.key > b.key) {
            return reverse ? -1 : 1;
        } else {
            return 0;
        }
    });
}

function RiakIterator(db, options) {
    AbstractIterator.call(this, db);

    options = JSON.parse(JSON.stringify(options));

    this._bucket = options.bucket || db._bucket;
    this._reverse = !!options.reverse;
    this._keyAsBuffer = !!options.keyAsBuffer;
    this._valueAsBuffer = !!options.valueAsBuffer;

    if (this._reverse) {
        options._start = options.start;
        options.start = options.end;
        options.end = options._start;
    }

    if (options.index && options.start) {
        this._inputs = {
            bucket: this._bucket,
            index: /_int$/.test(options.index) || /_bin$/.test(options.index) ? options.index : options.index + '_bin',
            start: '' + (options.gte || options.gt || options.start || '!'),
            end: '' + (options.lte || options.lt || options.end || '~')
        };
    } else {
        var filters = [];
        if (options.gt && options.lt) {
            filters.push(["between", options.gt, options.lt, false]);
        } else if (options.gte && options.lte) {
            filters.push(["between", options.gte, options.lte, true]);
        } else if (options.gt) {
            filters.push(["greater_than", options.gt]);
        } else if (options.gte) {
            filters.push(["greater_than_eq", options.gte]);
        } else if (options.lt) {
            filters.push(["less_than", options.lt]);
        } else if (options.lte) {
            filters.push(["less_than_eq", options.lte]);
        } else if (options.start && options.end) {
            filters.push(["between", options.start, options.end, true]);
        } else if (options.start) {
            filters.push(["greater_than_eq", options.start]);
        } else if (options.end) {
            filters.push(["less_than_eq", options.end]);
        }

        if (filters.length) {
            this._inputs = { bucket: this._bucket, key_filters: filters };
        }
    }

    this._inputs = this._inputs || this._bucket;

    var phases = [{
        map: {
            language: 'javascript',
            source: mapValues.toString()
        }
    }, {
        reduce: {
            language: 'javascript',
            source: sort.toString(),
            arg: this._reverse
        }
    }];

    if (options.limit > 0) {
        phases.push({ reduce: { language: 'javascript', name: 'Riak.reduceLimit', arg: options.limit + 1 } });
    }

    var request = {
        inputs: this._inputs,
        query: phases
    };

    this._results = db._client.mapred({ request: JSON.stringify(request), content_type: 'application/json' });

    this._results.once('end', function () {
        this._endEmitted = true;
    }.bind(this));
}

util.inherits(RiakIterator, AbstractIterator);

RiakIterator.prototype._next = function (callback) {
    var self = this;

    var onEnd = function () {
        self._results.removeListener('readable', onReadable);
        callback();
    };

    var onReadable = function () {
        self._results.removeListener('end', onEnd);
        self._next(callback);
    };

    var obj = this._results.read();

    if (self._endEmitted) {
        callback();
    } else if (obj === null) {
        this._results.once('readable', onReadable);
        this._results.once('end', onEnd);
    } else {
        if (this._keyAsBuffer) {
            obj.key = new Buffer(obj.key);
        }

        if (!this._valueAsBuffer) {
            obj.value = obj.value.toString();
        }

        callback(null, obj.key, obj.value);
    }
};

RiakIterator.prototype._end = function (callback) {
    callback();
};

module.exports = RiakIterator;
