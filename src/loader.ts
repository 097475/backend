/* eslint-disable @typescript-eslint/camelcase */
import fs = require('fs');
import parse = require('csv-parse/lib/sync');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const excelToJson = require('convert-excel-to-json');

////////// INTERFACES ///////////

interface Crime {
    ICCS_code?: string;
    ICCS_crime?: string;
    crime: string;
    value: number;
}

interface County {
    county: string;
    data: Array<Crime>;
}

interface Province {
    province: string;
    county: Array<County>;
    data?: Array<Crime>;
}

interface Region {
    region: string;
    province: Array<Province>;
    data?: Array<Crime>;
}

interface Year {
    year: string;
    region: Array<Region>;
    data?: Array<Crime>;
}

interface Country {
    country: string;
    year: Array<Year>;
}
//////// GENERAL USE FUNCTIONS /////////////
/**
 * merges same fields and removes NaNs
 *
 */
function _NaNtoZero(array: Array<Crime>): void {
    for (let i = 0; i < array.length; i++) {
        if (isNaN(array[i].value)) {
            //convert invalid values to 0
            array[i].value = 0;
        }
    }
}

function NaNtoZero(source: Country): void {
    for (const year of source.year) {
        if (year.data) {
            _NaNtoZero(year.data);
        }
        for (const region of year.region) {
            if (region.data) {
                _NaNtoZero(region.data);
            }
            for (const province of region.province) {
                if (province.data) {
                    _NaNtoZero(province.data);
                }
                for (const county of province.county) {
                    _NaNtoZero(county.data);
                }
            }
        }
    }
}

function _coalesce(array: Array<Crime>): void {
    let index1 = array.length - 1;
    while (index1 >= 1) {
        let index2 = index1 - 1;
        while (index2 >= 0) {
            if (array[index2].ICCS_code == array[index1].ICCS_code) {
                array[index1].value += array[index2].value;
                array[index2].value = NaN; //mark entries to be deleted as NaNs
            }
            index2 -= 1;
        }
        index1 -= 1;
    }
}

function _spliceNaNs(array: Array<Crime>): void {
    let index1 = array.length - 1;
    while (index1 >= 0) {
        if (isNaN(array[index1].value)) {
            array.splice(index1, 1);
        }
        index1 -= 1;
    }
}

function coalesce(source: Country): Country {
    for (const year of source.year) {
        if (year.data) {
            _NaNtoZero(year.data);
            _coalesce(year.data);
        }
        for (const region of year.region) {
            if (region.data) {
                _NaNtoZero(region.data);
                _coalesce(region.data);
            }
            for (const province of region.province) {
                if (province.data) {
                    _NaNtoZero(province.data);
                    _coalesce(province.data);
                }
                for (const county of province.county) {
                    _NaNtoZero(county.data);
                    _coalesce(county.data);
                }
            }
        }
    }

    for (const year of source.year) {
        if (year.data) {
            _spliceNaNs(year.data);
        }
        for (const region of year.region) {
            if (region.data) {
                _spliceNaNs(region.data);
            }
            for (const province of region.province) {
                if (province.data) {
                    _spliceNaNs(province.data);
                }
                for (const county of province.county) {
                    _spliceNaNs(county.data);
                }
            }
        }
    }

    return source;
}

function _disentangleSubcategory(array: Array<Crime>, topCategory: string, subCategory: string): void {
    const topcat = array.find(element => element.crime === topCategory);
    const subcat = array.find(element => element.crime === subCategory);
    if (topcat != undefined && subcat != undefined) {
        topcat.value -= subcat.value;
    }
}

//apply before mapping
function disentangleSubcategory(source: Country, topCategory: string, subCategory: string): Country {
    for (const year of source.year) {
        if (year.data) {
            _disentangleSubcategory(year.data, topCategory, subCategory);
        }
        for (const region of year.region) {
            if (region.data) {
                _disentangleSubcategory(region.data, topCategory, subCategory);
            }
            for (const province of region.province) {
                if (province.data) {
                    _disentangleSubcategory(province.data, topCategory, subCategory);
                }
                for (const county of province.county) {
                    _disentangleSubcategory(county.data, topCategory, subCategory);
                }
            }
        }
    }
    return source;
}

function disentangleSubcategories(source: Country, subcategories: Record<string, string>): Country {
    Object.entries(subcategories).forEach(([key, value]) => {
        source = disentangleSubcategory(source, key, value);
    });
    return source;
}

//levels: region, province, county, region+, province+
function rename(source: Country, level: string, substitutions: Record<string, string>): Country {
    switch (level) {
        case 'region': {
            for (const year of source.year) {
                year.region
                    .filter(element => element.region in substitutions)
                    .map(element => (element.region = substitutions[element.region]));
            }
            break;
        }
        case 'province': {
            for (const year of source.year) {
                for (const region of year.region) {
                    region.province
                        .filter(element => element.province in substitutions)
                        .map(element => (element.province = substitutions[element.province]));
                }
            }
            break;
        }
        case 'county': {
            for (const year of source.year) {
                for (const region of year.region) {
                    for (const province of region.province) {
                        province.county
                            .filter(element => element.county in substitutions)
                            .map(element => (element.county = substitutions[element.county]));
                    }
                }
            }
            break;
        }
        case 'region+': {
            rename(source, 'region', substitutions);
            rename(source, 'province', substitutions);
            rename(source, 'county', substitutions);
            break;
        }
        case 'province+': {
            rename(source, 'province', substitutions);
            rename(source, 'county', substitutions);
            break;
        }
        case 'default': {
            break;
        }
    }
    return source;
}

/**
 * Returns the input JSON with the corresponding ICCS entries
 */
function _mapCategories(array: Array<Crime>, matchingJSON: Record<string, string>, removeUnmatched: boolean): void {
    let index = array.length - 1;
    while (index >= 0) {
        const crime = array[index].crime;
        if (crime in matchingJSON) {
            array[index].ICCS_code = matchingJSON[crime][0];
            array[index].ICCS_crime = matchingJSON[crime][1];
        } else if (removeUnmatched) {
            array.splice(index, 1);
        }

        index -= 1;
    }
}

function mapCategories(source: Country, country: string, removeUnmatched: boolean, matchingPresent: boolean): Country {
    const matching = fs.readFileSync('data/matching/' + country + '/' + country + '-matching.txt', 'utf-8');
    const matchingJSON = JSON.parse(matching);

    for (const year of source.year) {
        if (year.data) {
            _mapCategories(year.data, matchingJSON, removeUnmatched);
        }
        for (const region of year.region) {
            if (region.data) {
                _mapCategories(region.data, matchingJSON, removeUnmatched);
            }
            for (const province of region.province) {
                if (province.data) {
                    _mapCategories(province.data, matchingJSON, removeUnmatched);
                }
                for (const county of province.county) {
                    _mapCategories(county.data, matchingJSON, removeUnmatched);
                }
            }
        }
    }
    return matchingPresent ? coalesce(source) : source;
}

///////////////////////////////////////////////////////////

///////// COUNTRY LOADING FUNCTIONS /////////////////
/**
 * Returns JSON from luxembourg's CSV file
 */

export function parseCSVLuxembourg(filename: string[]): Country {
    let text = fs.readFileSync(filename[0], 'utf-8');
    const output: Country = { country: 'Luxembourg', year: [] };

    text = text.replace('Year', 'Qualification');

    const records = parse(text, {
        columns: true,
        skip_empty_lines: true,
        skip_lines_with_error: true,
        cast: function(value) {
            return value.trim();
        },
    });

    let firstPass = true;
    for (const row of records) {
        let i = 0;
        Object.keys(row).forEach(function(key) {
            if (!isNaN(Number(key)) && firstPass) {
                const yearTemp: Year = {
                    year: key,
                    region: [
                        {
                            region: 'Luxembourg',
                            province: [{ province: 'Luxembourg', county: [{ county: 'Luxembourg', data: [] }] }],
                        },
                    ],
                };
                output.year.push(yearTemp);
            } else {
                if (!isNaN(Number(key))) {
                    output.year[i].region[0].province[0].county[0].data.push({
                        crime: row.Qualification,
                        value: Number(row[key]),
                    });
                }
            }
            i = i + 1;
        });
        firstPass = false;
    }

    return disentangleSubcategories(output, {
        'Thefts including acts of violence': 'thereof: thefts of vehicules including acts of violence',
    });
}
//double category
function parseXLSCyprus(filename: string[]): Country {
    const output: Country = { country: 'Cyprus', year: [{ year: '2019', region: [], data: [] }] };
    const seriousCrimes = excelToJson({
        sourceFile: filename[0],
        header: {
            rows: 3,
        },
        columnToKey: {
            A: '{{A2}}',
            B: '{{B2}}',
            E: '{{E2}}',
            H: '{{H2}}',
            K: '{{K2}}',
            N: '{{N2}}',
            Q: '{{Q2}}',
            T: '{{T2}}',
        },
        range: 'A4:T15',
    });
    const minorCrimes = excelToJson({
        sourceFile: filename[1],
        header: {
            rows: 3,
        },
        columnToKey: {
            A: '{{A2}}',
            B: '{{B2}}',
            E: '{{E2}}',
            H: '{{H2}}',
            K: '{{K2}}',
            N: '{{N2}}',
            Q: '{{Q2}}',
            T: '{{T2}}',
        },
        range: 'A4:T12',
    });
    const records = seriousCrimes['Serious crime'].concat(minorCrimes['Minor per off']);
    let firstPass = true;
    for (const row of records) {
        let i = 0;
        let crime = '';
        Object.keys(row).forEach(function(key) {
            if (key == 'Offences') {
                crime = row[key];
            } else if (key == 'TOTAL') {
                output.year[0].data?.push({ crime: crime, value: Number(row[key]) });
            } else if (firstPass) {
                output.year[0].region.push({
                    region: key,
                    province: [
                        { province: key, county: [{ county: key, data: [{ crime: crime, value: Number(row[key]) }] }] },
                    ],
                });
            } else {
                output.year[0].region[i - 1].province[0].county[0].data.push({ crime: crime, value: Number(row[key]) });
            }
            i = i + 1;
        });
        firstPass = false;
    }
    return rename(output, 'region+', { Limasol: 'Limassol', Ammochostos: 'Famagusta', Morfou: 'Kyrenia' });
}

export function parseXLSHungary(filename: string[]): Country {
    const output: Country = { country: 'Hungary', year: [] };
    let records = excelToJson({
        sourceFile: filename[0],
        header: {
            rows: 3,
        },
        columnToKey: {
            A: 'Crime_or_location',
            B: 'Level',
            C: '{{C2}}',
            D: '{{D2}}',
            E: '{{E2}}',
            F: '{{F2}}',
            G: '{{G2}}',
            H: '{{H2}}',
            I: '{{I2}}',
            J: '{{J2}}',
            K: '{{K2}}',
            L: '{{L2}}',
            M: '{{M2}}',
            N: '{{N2}}',
            O: '{{O2}}',
            P: '{{P2}}',
            Q: '{{Q2}}',
            R: '{{R2}}',
            S: '{{S2}}',
            T: '{{T2}}',
            U: '{{U2}}',
        },
    });
    let firstPassYears = true;
    let firstPassRegions = true;
    let crimePasses = 0;
    let j = 0;
    let crime = '';
    records = records['6.2.7.2.'];
    for (const row of records) {
        let i = 0;
        if (Object.keys(row).length == 1) {
            crime = row.Crime_or_location.replace('$', '');
            crimePasses++;
            if (crimePasses === 2) {
                firstPassRegions = false;
            }
            j = 0;
        } else {
            if (row.Level.includes('capital') || row.Level.includes('county')) {
                Object.keys(row).forEach(function(key) {
                    if (!isNaN(Number(key)) && firstPassYears) {
                        const yearTemp: Year = {
                            year: key,
                            region: [
                                {
                                    region: row.Crime_or_location,
                                    province: [
                                        {
                                            province: row.Crime_or_location,
                                            county: [
                                                {
                                                    county: row.Crime_or_location,
                                                    data: [{ crime: crime, value: Number(row[key]) }],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            ],
                            data: [],
                        };
                        output.year.push(yearTemp);
                    } else {
                        if (!isNaN(Number(key)) && firstPassRegions) {
                            output.year[i].region.push({
                                region: row.Crime_or_location,
                                province: [
                                    {
                                        province: row.Crime_or_location,
                                        county: [
                                            {
                                                county: row.Crime_or_location,
                                                data: [{ crime: crime, value: Number(row[key]) }],
                                            },
                                        ],
                                    },
                                ],
                            });
                        } else if (!isNaN(Number(key))) {
                            output.year[i].region[j].province[0].county[0].data.push({
                                crime: crime,
                                value: Number(row[key]),
                            });
                        }
                    }
                    i = i + 1;
                });
                firstPassYears = false;
            } else {
                if (row.Level === 'country') {
                    Object.keys(row).forEach(function(key) {
                        if (!isNaN(Number(key)) && output.year[i].data) {
                            output.year[i].data?.push({ crime: crime, value: Number(row[key]) });
                            i = i + 1;
                        }
                    });
                }
                j--;
            }
            j = j + 1;
        }
    }

    return output;
}

//homicide too, crime against youth too and many others, more categories available for total, generally dangerous crimes
export function parseXLSBulgaria(filename: string[]): Country {
    const output: Country = {
        country: 'Bulgaria',
        year: [],
    };
    const records = excelToJson({
        sourceFile: filename[0],
        columnToKey: {
            A: 'Crime_or_location',
            B: 'Value',
        },
        range: 'A7:B516',
    });
    for (let y = 2018; y >= 2016; y--) {
        const current = records[y.toString()];
        output.year.push({ year: y.toString(), region: [], data: [] });
        for (let i = 0; i < current.length; i += 17) {
            const location = current[i].Crime_or_location;
            if (i != 0 && i != 17) {
                output.year[2018 - y].region.push({
                    region: location,
                    province: [{ province: location, county: [{ county: location, data: [] }] }],
                });
            }

            for (let j = i + 1; j < i + 17; j++) {
                if (i === 0) {
                    output.year[2018 - y].data?.push({
                        crime: current[j].Crime_or_location,
                        value: Number(current[j].Value),
                    });
                } else if (i === 17) {
                    continue;
                } else {
                    output.year[2018 - y].region[
                        output.year[2018 - y].region.length - 1
                    ].province[0].county[0].data.push({
                        crime: current[j].Crime_or_location,
                        value: Number(current[j].Value),
                    });
                }
            }
        }
    }
    return output;
}

export function parseXLSPortugal(filename: string[]): Country {
    const output: Country = { country: 'Portugal', year: [{ year: '2018', region: [], data: [] }] };
    let records = excelToJson({
        sourceFile: filename[0],
        header: {
            rows: 11,
        },
        columnToKey: {
            A: 'Place',
            B: 'Level',
            C: '{{C10}}',
            E: '{{E10}}',
            G: '{{G10}}',
            I: '{{I10}}',
            K: '{{K10}}',
            M: '{{M10}}',
            O: '{{O10}}',
            Q: '{{Q10}}',
            S: '{{S10}}',
        },
        range: 'A12:S355',
    });
    records = records['Table'];
    let regions = -1;
    let provinces = -1;
    let counties = -1;
    for (const row of records) {
        if (row.Level === 'PT') {
            Object.keys(row).forEach(function(key) {
                if (key !== 'Place' && key !== 'Level' && key !== 'Total') {
                    output.year[0].data?.push({ crime: key, value: Number(row[key]) });
                }
            });
        } else {
            switch (row.Level.length) {
                case 1:
                    break; //continent
                case 2:
                    output.year[0].region.push({ region: row.Place, province: [], data: [] });
                    regions++;
                    provinces = -1;
                    Object.keys(row).forEach(function(key) {
                        if (key !== 'Place' && key !== 'Level' && key !== 'Total') {
                            output.year[0].region[regions].data?.push({ crime: key, value: Number(row[key]) });
                        }
                    });
                    //regions++;
                    break; //region
                case 3:
                    output.year[0].region[regions].province.push({ province: row.Place, county: [], data: [] });
                    provinces++;
                    counties = -1;
                    //console.log(output.year[0].region[regions].province);
                    //console.log(provinces);
                    Object.keys(row).forEach(function(key) {
                        if (key !== 'Place' && key !== 'Level' && key !== 'Total') {
                            output.year[0].region[regions].province[provinces].data?.push({
                                crime: key,
                                value: Number(row[key]),
                            });
                        }
                    });
                    //provinces++;
                    break; //province
                default:
                    output.year[0].region[regions].province[provinces].county.push({ county: row.Place, data: [] });
                    counties++;
                    Object.keys(row).forEach(function(key) {
                        if (key !== 'Place' && key !== 'Level' && key !== 'Total') {
                            //console.log(output.year[0].region[regions].province[provinces].county);
                            output.year[0].region[regions].province[provinces].county[counties].data.push({
                                crime: key,
                                value: Number(row[key]),
                            });
                        }
                    });
                    //counties++;
                    break; //county
            }
        }
    }
    return output;
}

export function parseCSVDenmark(filename: string[]): Country {
    const text = fs.readFileSync(filename[0], 'utf-8');
    const output: Country = { country: 'Denmark', year: [{ year: '2019', region: [], data: [] }] };

    const records = parse(text, {
        from_line: 4,
        to_line: 9633,
        relax_column_count: true,
    });
    //return records;
    let firstPass = true;
    for (let i = 0; i < records.length - 11; i += 107) {
        //["Nature of the offence, total"]
        console.log(i);
        const crime = records[i][0];
        let regions = -1;
        let provinces = -1;
        for (let j = i + 1; j < i + 107; j++) {
            // [" ","All Denmark","119055"]
            if (records[j][1].includes('All')) {
                output.year[0].data?.push({ crime: crime, value: Number(records[j][2]) });
            } else if (records[j][1].includes('Region')) {
                provinces = -1;
                regions++;
                if (firstPass) {
                    output.year[0].region.push({
                        region: records[j][1].replace('Region', ''),
                        data: [{ crime: crime, value: Number(records[j][2]) }],
                        province: [],
                    });
                } else {
                    output.year[0].region[regions].data?.push({ crime: crime, value: Number(records[j][2]) });
                }
            } else {
                provinces++;
                if (firstPass) {
                    output.year[0].region[regions].province.push({
                        province: records[j][1],
                        county: [{ county: records[j][1], data: [{ crime: crime, value: Number(records[j][2]) }] }],
                    });
                } else {
                    output.year[0].region[regions].province[provinces].county[0].data.push({
                        crime: crime,
                        value: Number(records[j][2]),
                    });
                }
            }
        }
        firstPass = false;
    }
    return output;
}
///////////////////////////////////////////////////////

//////// DICTIONARY OF FUNCTIONS ////////////
/**
 * Contains all the country specific parsers
 */
const countryFunctions: Record<string, Function> = {
    luxembourg: parseCSVLuxembourg,
    cyprus: parseXLSCyprus,
    hungary: parseXLSHungary,
    bulgaria: parseXLSBulgaria,
    portugal: parseXLSPortugal,
    denmark: parseCSVDenmark,
};

const countrySources: Record<string, Array<string>> = {
    luxembourg: ['data/source_files/luxembourg/luxembourg.csv'],
    cyprus: ['data/source_files/cyprus/cyprus_1.xls', 'data/source_files/cyprus/cyprus_2.xls'],
    hungary: ['data/source_files/hungary/hungary.xls'],
    bulgaria: ['data/source_files/bulgaria/bulgaria.xls'],
    denmark: ['data/source_files/denmark/denmark.csv'],
    portugal: ['data/source_files/portugal/portugal.xls'],
};
////////////////////////////////////////////
///////////PUBLIC FUNCTIONS////////////////
/**
 * Returns the JSON with ICCS categories of the specified country with source of the specified extension (eg. .csv, .xls, .xlsx)
 */
export function getData(country: string): Country {
    const data = countryFunctions[country](countrySources[country]);
    NaNtoZero(data);
    //const JSONData = mapCategories(data, country, false, false);
    return data;
}
