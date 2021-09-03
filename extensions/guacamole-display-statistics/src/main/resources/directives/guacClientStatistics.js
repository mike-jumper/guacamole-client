/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * A directive which displays one or more Guacamole clients in an evenly-tiled
 * view. The number of rows and columns used for the arrangement of tiles is
 * automatically determined by the number of clients present.
 */
angular.module('client').directive('guacClientStatistics', [function guacClientStatistics() {

    const directive = {
        restrict: 'E',
        templateUrl: 'app/ext/display-stats/templates/guacClientStatistics.html',
    };

    directive.scope = {

        /**
         * The group of Guacamole clients that should be displayed in an
         * evenly-tiled grid arrangement.
         *
         * @type ManagedClientGroup
         */
        client : '='

    };

    directive.controller = ['$scope', function guacClientStatisticsController($scope) {

        var updateStatistics = function updateStatistics(stats) {
            $scope.$apply(function statisticsChanged() {
                $scope.statistics = stats;
            });
        };

        $scope.hasValue = function hasValue(value) {
            return value || value === 0;
        };

        $scope.round = function round(value) {
            return Math.round(value * 100) / 100;
        };

        $scope.$watch('client', function clientChanged(client, oldClient) {

            if (oldClient)
                oldClient.managedDisplay.display.onstatistics = null;

            client.managedDisplay.display.statisticWindow = 1000;
            client.managedDisplay.display.onstatistics = updateStatistics;

        });

        $scope.$on('$destroy', function scopeDestroyed() {
            if ($scope.client)
                $scope.client.managedDisplay.display.onstatistics = null;
        });

    }];

    return directive;

}]);
